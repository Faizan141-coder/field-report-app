import fs from 'node:fs';
import path from 'node:path';
import {Redis} from '@upstash/redis';

export type FaultMode =
  | 'none' | 'error500' | 'error503' | 'reject400' | 'hang' | 'drop' | 'dropMidBody' | 'loseResponse';
export interface Faults {
  mode: FaultMode;
  times: number;
  latencyMs: number;
  dropAfterBytes: number;
}
export const NO_FAULTS: Faults = {mode: 'none', times: 0, latencyMs: 0, dropAfterBytes: 20_000};

export interface ReportDoc {
  id: string;
  description: string;
  imageCount: number;
  createdAt?: string;
  receivedAt: string;
}
export type ChunkResult =
  | {kind: 'gap'; offset: number}
  | {kind: 'ok'; complete: boolean; received: number; alreadyComplete: boolean};

/** Everything the HTTP layer needs from storage. Two backends: local disk (dev, tests) and Redis (Vercel). */
export interface Store {
  imageStatus(id: string, idx: number): Promise<{complete: boolean; received: number}>;
  putChunk(id: string, idx: number, start: number, total: number, body: Buffer): Promise<ChunkResult>;
  readImage(id: string, idx: number): Promise<Buffer | undefined>;
  imageSize(id: string, idx: number): Promise<number | undefined>;
  hasReport(id: string): Promise<boolean>;
  saveReport(doc: ReportDoc): Promise<void>;
  listReports(): Promise<ReportDoc[]>;
  reset(): Promise<void>;
  getFaults(): Promise<Faults>;
  setFaults(f: Faults): Promise<void>;
  /** Consumes one use of the active fault (if counted) and returns its mode. */
  takeFault(): Promise<FaultMode>;
}

// ---- local disk ------------------------------------------------------------
export function fsStore(DATA: string): Store {
  const img = (id: string, i: number) => path.join(DATA, 'images', id, `${i}.jpg`);
  const part = (id: string, i: number) => `${img(id, i)}.part`;
  const rep = (id: string) => path.join(DATA, 'reports', `${id}.json`);
  const init = () => {
    fs.mkdirSync(path.join(DATA, 'images'), {recursive: true});
    fs.mkdirSync(path.join(DATA, 'reports'), {recursive: true});
  };
  init();
  let faults = {...NO_FAULTS};
  let remaining = 0;
  const have = (id: string, i: number) => (fs.existsSync(part(id, i)) ? fs.statSync(part(id, i)).size : 0);
  return {
    async imageStatus(id, i) {
      const complete = fs.existsSync(img(id, i));
      return {complete, received: complete ? fs.statSync(img(id, i)).size : have(id, i)};
    },
    async putChunk(id, i, start, total, body) {
      const final = img(id, i);
      fs.mkdirSync(path.dirname(final), {recursive: true});
      if (fs.existsSync(final) && fs.statSync(final).size === total) {
        return {kind: 'ok', complete: true, received: total, alreadyComplete: true};
      }
      const h = have(id, i);
      if (start > h) return {kind: 'gap', offset: h};
      if (start < h) fs.truncateSync(part(id, i), start);
      fs.appendFileSync(part(id, i), body);
      const now = start + body.length;
      const complete = now === total;
      if (complete) fs.renameSync(part(id, i), final);
      return {kind: 'ok', complete, received: now, alreadyComplete: false};
    },
    async readImage(id, i) {
      return fs.existsSync(img(id, i)) ? fs.readFileSync(img(id, i)) : undefined;
    },
    async imageSize(id, i) {
      return fs.existsSync(img(id, i)) ? fs.statSync(img(id, i)).size : undefined;
    },
    async hasReport(id) {
      return fs.existsSync(rep(id));
    },
    async saveReport(doc) {
      fs.writeFileSync(rep(doc.id), JSON.stringify(doc));
    },
    async listReports() {
      return fs
        .readdirSync(path.join(DATA, 'reports'))
        .map(f => JSON.parse(fs.readFileSync(path.join(DATA, 'reports', f), 'utf8')) as ReportDoc)
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    },
    async reset() {
      fs.rmSync(DATA, {recursive: true, force: true});
      init();
    },
    async getFaults() {
      return faults;
    },
    async setFaults(f) {
      faults = f;
      remaining = f.times;
    },
    async takeFault() {
      if (faults.mode === 'none') return 'none';
      if (faults.times > 0) {
        if (remaining <= 0) return 'none';
        remaining--;
      }
      return faults.mode;
    },
  };
}

// ---- Redis (Upstash, via Vercel Marketplace) ---------------------------------
// Each image is a hash `p:<id>:<idx>` of base64 chunks keyed by start offset, plus `off`
// (contiguous bytes received) and `done` (total, set once the last byte arrived). No chunk is
// ever rewritten, so a request stays far below Vercel's 4.5 MB body cap and Upstash's limits.
export function redisStore(url: string, token: string): Store {
  const r = new Redis({url, token, automaticDeserialization: false});
  const key = (id: string, i: number) => `p:${id}:${i}`;
  const num = (v: unknown) => (v == null ? undefined : Number(v));
  // With auto-deserialization off the client returns raw arrays: HMGET -> values in order,
  // HGETALL -> flat [field, value, ...].
  const meta = async (k: string) => {
    const [off, done] = (await r.hmget(k, 'off', 'done')) as unknown as (string | null)[];
    return {off: num(off), done: num(done)};
  };
  const all = async (k: string) => {
    const flat = ((await r.hgetall(k)) ?? []) as unknown as string[];
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  };
  return {
    async imageStatus(id, i) {
      const {off, done} = await meta(key(id, i));
      return done !== undefined ? {complete: true, received: done} : {complete: false, received: off ?? 0};
    },
    async putChunk(id, i, start, total, body) {
      const k = key(id, i);
      const {off, done} = await meta(k);
      if (done === total) return {kind: 'ok', complete: true, received: total, alreadyComplete: true};
      const h = off ?? 0;
      if (start > h) return {kind: 'gap', offset: h};
      if (start < h) {
        // Re-sent chunk: drop everything from `start` on, then overwrite.
        const stale = (await r.hkeys(k)).filter(f => /^\d+$/.test(f) && Number(f) >= start);
        if (stale.length) await r.hdel(k, ...stale);
      }
      const now = start + body.length;
      await r.hset(k, {[String(start)]: body.toString('base64'), off: String(now), ...(now === total ? {done: String(total)} : {})});
      return {kind: 'ok', complete: now === total, received: now, alreadyComplete: false};
    },
    async readImage(id, i) {
      const h = await all(key(id, i));
      if (h.done === undefined) return undefined;
      return Buffer.concat(
        Object.keys(h)
          .filter(f => /^\d+$/.test(f))
          .sort((a, b) => Number(a) - Number(b))
          .map(f => Buffer.from(h[f], 'base64')),
      );
    },
    async imageSize(id, i) {
      return (await meta(key(id, i))).done;
    },
    async hasReport(id) {
      return (await r.exists(`r:${id}`)) === 1;
    },
    async saveReport(doc) {
      await r.set(`r:${doc.id}`, JSON.stringify(doc));
      await r.zadd('reports', {score: Date.parse(doc.receivedAt), member: doc.id});
    },
    async listReports() {
      const ids = await r.zrange<string[]>('reports', 0, -1, {rev: true});
      if (!ids.length) return [];
      return (await r.mget<string[]>(...ids.map(id => `r:${id}`))).filter(Boolean).map(s => JSON.parse(s as string));
    },
    async reset() {
      await r.flushdb();
    },
    async getFaults() {
      const s = await r.get<string>('faults');
      return s ? JSON.parse(s) : {...NO_FAULTS};
    },
    async setFaults(f) {
      await r.set('faults', JSON.stringify(f));
      await r.set('faults:left', String(f.times));
    },
    async takeFault() {
      const s = await r.get<string>('faults');
      if (!s) return 'none';
      const f: Faults = JSON.parse(s);
      if (f.mode === 'none') return 'none';
      if (f.times > 0 && (await r.decr('faults:left')) < 0) return 'none';
      return f.mode;
    },
  };
}

export function storeFromEnv(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return redisStore(url, token);
  if (process.env.VERCEL) throw new Error('Redis env vars missing (connect an Upstash Redis store to this project)');
  return fsStore(path.resolve(process.env.DATA_DIR ?? 'data'));
}
