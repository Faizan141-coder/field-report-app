/**
 * transient       retry automatically, forever, with backoff (network, timeout, 5xx, 408, 429)
 * permanent       retrying cannot help (other 4xx, unreadable source); needs the user
 * tooLarge        server refused the size; re-compress harder and retry a bounded number of times
 * missingOnServer commit found images the server doesn't have; re-send them
 */
export type UploadErrorKind = 'transient' | 'permanent' | 'tooLarge' | 'missingOnServer';

export class UploadError extends Error {
  constructor(
    public readonly kind: UploadErrorKind,
    message: string,
    public readonly opts: {status?: number; retryAfterMs?: number; missing?: number[]} = {},
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function classifyStatus(status: number, body?: unknown, retryAfterMs?: number): UploadError {
  const msg = `Server responded ${status}`;
  if (status === 413) return new UploadError('tooLarge', msg, {status});
  if (status === 409 && Array.isArray((body as {missing?: unknown})?.missing)) {
    return new UploadError('missingOnServer', msg, {
      status,
      missing: (body as {missing: number[]}).missing,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new UploadError('transient', msg, {status, retryAfterMs});
  }
  return new UploadError('permanent', msg, {status});
}
