import {backoffMs} from './backoff';
import {UploadError, ValidationError} from './errors';
import {withStallWatchdog} from './stall';
import {
  FileOps,
  ImagePreparer,
  MAX_IMAGES,
  Report,
  ReportApi,
  ReportDraft,
  ReportImage,
  ReportStore,
} from './types';

export interface EngineDeps {
  store: ReportStore;
  api: ReportApi;
  preparer: ImagePreparer;
  files: FileOps;
  isOnline: () => boolean;
  now?: () => number;
  random?: () => number;
  /** No-progress window after which an in-flight request is abandoned. */
  stallMs?: number;
  /** How many "too large" rejections per image before we give up and ask the user. */
  maxTooLargeRetries?: number;
}

type Listener = () => void;

/**
 * Durable upload queue. One worker, one report at a time: on a 2G link,
 * parallelism only makes every upload slower and every failure more likely.
 *
 * Invariants:
 *  - A report is persisted *before* enqueue() resolves; nothing in memory is the source of truth.
 *  - State is saved after every step (prepared, image uploaded, committed), so a kill at any
 *    point resumes from the last completed step.
 *  - Re-sending is always safe: the server keys on (reportId, index) and on reportId.
 *  - `uploaded` is only ever set after the server's commit succeeded.
 */
export class UploadEngine {
  private reports = new Map<string, Report>();
  private snapshot: readonly Report[] = [];
  private listeners = new Set<Listener>();
  private progress = new Map<string, number>();
  private progressListeners = new Set<Listener>();
  private lastProgressEmit = 0;
  private running = false;
  private wake: (() => void) | null = null;
  private abort = new AbortController();
  private ready = false;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly stallMs: number;
  private readonly maxTooLarge: number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.stallMs = deps.stallMs ?? 30_000;
    this.maxTooLarge = deps.maxTooLargeRetries ?? 3;
  }

  // ---- observable state ----------------------------------------------------

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  /** 0..1 for the report currently uploading, otherwise undefined. Separate store: it ticks fast. */
  subscribeProgress = (l: Listener) => {
    this.progressListeners.add(l);
    return () => void this.progressListeners.delete(l);
  };
  getProgress = (id: string) => this.progress.get(id);

  private setProgress(id: string, value: number | undefined, force = false) {
    if (value === undefined) this.progress.delete(id);
    else this.progress.set(id, value);
    const t = this.now();
    if (force || t - this.lastProgressEmit > 200) {
      this.lastProgressEmit = t;
      this.progressListeners.forEach(l => l());
    }
  }

  private publish() {
    // Copy-on-publish: the worker mutates its own Report objects in place, so UI consumers get
    // fresh copies. Otherwise memoized rows see the same reference and never re-render.
    this.snapshot = [...this.reports.values()]
      .map(r => ({...r, images: r.images.map(i => ({...i})), lastError: r.lastError && {...r.lastError}}))
      .sort((a, b) => b.createdAt - a.createdAt);
    this.listeners.forEach(l => l());
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Load persisted reports. Anything left "uploading" by a kill goes back to queued. */
  async init(): Promise<void> {
    for (const r of await this.deps.store.loadAll()) {
      if (r.phase === 'uploading') {
        r.phase = 'queued';
        r.nextAttemptAt = null;
        await this.deps.store.save(r);
      }
      this.reports.set(r.id, r);
    }
    this.ready = true;
    this.publish();
    this.kick();
  }

  /** Persist first, then let the worker pick it up. Resolves once the report is safe on disk. */
  async enqueue(draft: ReportDraft): Promise<Report> {
    const description = draft.description.trim();
    if (!description) throw new ValidationError('Add a short description.');
    if (draft.imageUris.length < 1) throw new ValidationError('Add at least one photo.');
    if (draft.imageUris.length > MAX_IMAGES) {
      throw new ValidationError(`A report can have at most ${MAX_IMAGES} photos.`);
    }
    const report: Report = {
      id: draft.id,
      description,
      createdAt: this.now(),
      images: draft.imageUris.map(
        (originalUri, index): ReportImage => ({
          index,
          originalUri,
          compressionStep: 0,
          uploaded: false,
        }),
      ),
      phase: 'queued',
      attempts: 0,
      nextAttemptAt: null,
    };
    await this.deps.store.save(report);
    this.reports.set(report.id, report);
    this.publish();
    this.kick();
    return report;
  }

  /** User pressed "try again" on a needs-attention report. */
  async retry(id: string): Promise<void> {
    const r = this.reports.get(id);
    if (!r || r.phase !== 'needsAttention') return;
    r.phase = 'queued';
    r.attempts = 0;
    r.nextAttemptAt = null;
    r.lastError = undefined;
    r.images.forEach(i => (i.compressionStep = 0));
    await this.persist(r);
    this.kick();
  }

  /** Network came back / app foregrounded / user asked: skip any backoff wait. */
  nudge(): void {
    for (const r of this.reports.values()) {
      if (r.phase === 'queued') r.nextAttemptAt = null;
    }
    this.wake?.(); // cut short a backoff sleep
    this.kick();
  }

  /** User gives up on a report that needs attention. This is the one way unsent work is deleted. */
  async discard(id: string): Promise<void> {
    const r = this.reports.get(id);
    if (!r || r.phase !== 'needsAttention') return;
    this.reports.delete(id);
    this.publish();
    await this.cleanupFiles(r);
    await this.deps.store.remove(id);
  }

  /** Forget local records of reports the server already holds. */
  async clearUploaded(): Promise<void> {
    for (const r of [...this.reports.values()]) if (r.phase === 'uploaded') await this.dismiss(r.id);
  }

  /** Drop everything local. In-flight work is aborted first. */
  async clearAll(): Promise<void> {
    this.abort.abort();
    this.abort = new AbortController();
    const all = [...this.reports.values()];
    this.reports.clear();
    this.publish();
    for (const r of all) {
      await this.cleanupFiles(r);
      await this.deps.store.remove(r.id);
    }
  }

  /** Delete an already-uploaded report's bookkeeping from the device (never un-sends it). */
  async dismiss(id: string): Promise<void> {
    const r = this.reports.get(id);
    if (!r || r.phase !== 'uploaded') return;
    this.reports.delete(id);
    this.publish();
    await this.deps.store.remove(id);
  }

  // ---- worker --------------------------------------------------------------

  kick(): void {
    if (this.running || !this.ready) return;
    this.running = true;
    this.loop()
      .catch(e => console.warn('[engine] loop crashed', e))
      .finally(() => {
        this.running = false;
        // A report enqueued while the loop was winding down must not be stranded.
        // Offline is excluded on purpose: the loop exits immediately when offline, so
        // re-kicking here would spin forever. nudge() restarts us on reconnect.
        if (this.deps.isOnline() && this.nextDue() !== undefined) this.kick();
      });
  }

  private nextDue(): Report | undefined {
    const t = this.now();
    return [...this.reports.values()]
      .filter(r => r.phase === 'queued' && (r.nextAttemptAt ?? 0) <= t)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (!this.deps.isOnline()) return; // nudge() on reconnect restarts us
      const due = this.nextDue();
      if (due) {
        await this.process(due);
        continue;
      }
      const waiting = [...this.reports.values()]
        .filter(r => r.phase === 'queued' && r.nextAttemptAt !== null)
        .map(r => r.nextAttemptAt as number);
      if (!waiting.length) return;
      await this.sleepUntil(Math.min(...waiting));
    }
  }

  private sleepUntil(at: number): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      timer = setTimeout(done, Math.max(0, at - this.now()));
      this.wake = done;
    });
  }

  private async process(r: Report): Promise<void> {
    const signal = this.abort.signal;
    r.phase = 'uploading';
    r.nextAttemptAt = null;
    await this.persist(r);
    try {
      for (const img of r.images) {
        if (img.uploaded) continue;
        if (!img.preparedUri) {
          const p = await this.deps.preparer.prepare(img.originalUri, img.compressionStep);
          img.preparedUri = p.uri;
          img.preparedBytes = p.bytes;
          await this.persist(r);
        }
        const doneCount = r.images.filter(i => i.uploaded).length;
        await withStallWatchdog(this.stallMs, signal, (sig, touch) =>
          this.deps.api.uploadImage({
            reportId: r.id,
            index: img.index,
            uri: img.preparedUri!,
            bytes: img.preparedBytes!,
            signal: sig,
            onProgress: sent => {
              touch();
              this.setProgress(r.id, (doneCount + Math.min(1, sent / img.preparedBytes!)) / r.images.length);
            },
          }),
        );
        img.uploaded = true;
        this.setProgress(r.id, (doneCount + 1) / r.images.length);
        await this.persist(r);
      }
      await withStallWatchdog(this.stallMs, signal, sig =>
        this.deps.api.commit(
          {
            id: r.id,
            description: r.description,
            imageCount: r.images.length,
            createdAt: r.createdAt,
          },
          sig,
        ),
      );
      r.phase = 'uploaded';
      r.committedAt = this.now();
      r.lastError = undefined;
      await this.persist(r);
      await this.cleanupFiles(r);
    } catch (e) {
      if (signal.aborted || !this.reports.has(r.id)) return; // clearAll() ran
      await this.handleFailure(r, e);
    } finally {
      this.setProgress(r.id, undefined, true);
    }
  }

  private async handleFailure(r: Report, e: unknown): Promise<void> {
    const err =
      e instanceof UploadError
        ? e
        : // fetch/blob-util network failures arrive as plain errors with no status
          new UploadError('transient', e instanceof Error ? e.message : String(e));
    const at = this.now();

    switch (err.kind) {
      case 'transient': {
        r.attempts += 1;
        r.phase = 'queued';
        r.nextAttemptAt = at + backoffMs(r.attempts, this.random, err.opts.retryAfterMs);
        r.lastError = {message: err.message, at, retrying: true};
        break;
      }
      case 'missingOnServer': {
        r.attempts += 1;
        r.phase = 'queued';
        r.nextAttemptAt = null;
        const missing = new Set(err.opts.missing ?? r.images.map(i => i.index));
        r.images.forEach(i => missing.has(i.index) && (i.uploaded = false));
        r.lastError = {message: 'Server was missing photos; re-sending', at, retrying: true};
        break;
      }
      case 'tooLarge': {
        // Which image was refused isn't carried on the error; re-prepare every image that
        // hasn't been acknowledged yet, one step harder.
        const pending = r.images.filter(i => !i.uploaded);
        if (pending.some(i => i.compressionStep >= this.maxTooLarge)) {
          r.phase = 'needsAttention';
          r.nextAttemptAt = null;
          r.lastError = {message: 'A photo is still too large after compression', at, retrying: false};
        } else {
          pending.forEach(i => {
            i.compressionStep += 1;
            i.preparedUri = undefined;
            i.preparedBytes = undefined;
          });
          r.phase = 'queued';
          r.nextAttemptAt = null;
          r.lastError = {message: 'Photo too large; compressing harder', at, retrying: true};
        }
        break;
      }
      case 'permanent': {
        r.phase = 'needsAttention';
        r.nextAttemptAt = null;
        r.lastError = {message: err.message, at, retrying: false};
        break;
      }
    }
    await this.persist(r);
  }

  // ---- helpers -------------------------------------------------------------

  private async persist(r: Report): Promise<void> {
    await this.deps.store.save(r);
    this.publish();
  }

  private async cleanupFiles(r: Report): Promise<void> {
    for (const i of r.images) {
      for (const uri of [i.originalUri, i.preparedUri]) {
        if (uri) await this.deps.files.remove(uri).catch(() => {});
      }
    }
  }
}
