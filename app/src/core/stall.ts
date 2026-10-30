import {UploadError} from './errors';

/**
 * Runs `run` with an AbortSignal that fires if no progress is reported for
 * `stallMs`. Whole-request timeouts are wrong on 2G (a healthy upload can take
 * minutes); a *stall* is what means the link is dead.
 */
export async function withStallWatchdog<T>(
  stallMs: number,
  parent: AbortSignal,
  run: (signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, stallMs);
  };
  const onParentAbort = () => ctl.abort();
  parent.addEventListener('abort', onParentAbort);
  arm();
  try {
    return await run(ctl.signal, arm);
  } catch (e) {
    if (stalled) throw new UploadError('transient', 'Connection stalled');
    throw e;
  } finally {
    clearTimeout(timer!);
    parent.removeEventListener('abort', onParentAbort);
  }
}
