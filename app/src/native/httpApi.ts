import ReactNativeBlobUtil from 'react-native-blob-util';
import {classifyStatus, UploadError} from '../core/errors';
import {CommitArgs, ReportApi, UploadImageArgs} from '../core/types';

const fs = ReactNativeBlobUtil.fs;
/** Small enough that a dropped link on 2G forfeits seconds of work, not minutes. */
const CHUNK_BYTES = 64 * 1024;

const retryAfter = (h: Record<string, string> | undefined) => {
  const v = h && (h['Retry-After'] ?? h['retry-after']);
  return v && !Number.isNaN(Number(v)) ? Number(v) * 1000 : undefined;
};
const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function createHttpApi(baseUrl: string): ReportApi {
  async function status(reportId: string, index: number, signal: AbortSignal) {
    const res = await fetch(`${baseUrl}/reports/${reportId}/images/${index}/status`, {signal});
    if (!res.ok) throw classifyStatus(res.status, undefined);
    return (await res.json()) as {complete: boolean; received: number};
  }

  return {
    /** Resumable: ask the server where it is, send the next slice, repeat until done. */
    async uploadImage({reportId, index, uri, bytes, signal, onProgress}: UploadImageArgs) {
      const path = uri.replace(/^file:\/\//, '');
      let offset = (await status(reportId, index, signal)).received;
      if (offset >= bytes) return;
      onProgress(offset);

      while (offset < bytes) {
        const end = Math.min(offset + CHUNK_BYTES, bytes);
        const slice = `${path}.chunk`;
        await fs.slice(path, slice, offset, end);
        let task: ReturnType<typeof ReactNativeBlobUtil.fetch> | undefined;
        const onAbort = () => task?.cancel();
        signal.addEventListener('abort', onAbort);
        try {
          task = ReactNativeBlobUtil.config({timeout: 60_000}).fetch(
            'PUT',
            `${baseUrl}/reports/${reportId}/images/${index}`,
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': `bytes ${offset}-${end - 1}/${bytes}`,
            },
            ReactNativeBlobUtil.wrap(slice),
          );
          task.uploadProgress({interval: 250}, sent => onProgress(offset + sent));
          const res = await task;
          const code = res.info().status;
          const body = parse(String(await res.text()));
          if (code === 409 && typeof body?.offset === 'number') {
            offset = body.offset; // server is behind/ahead of us: realign and carry on
            continue;
          }
          if (code < 200 || code >= 300) {
            throw classifyStatus(code, body, retryAfter(res.info().headers));
          }
          offset = typeof body?.received === 'number' ? body.received : end;
          onProgress(offset);
        } finally {
          signal.removeEventListener('abort', onAbort);
          await fs.unlink(slice).catch(() => {});
        }
      }
    },

    async commit(args: CommitArgs, signal: AbortSignal) {
      const res = await fetch(`${baseUrl}/reports/${args.id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          description: args.description,
          imageCount: args.imageCount,
          createdAt: args.createdAt,
        }),
        signal,
      });
      if (res.ok) return;
      const body = await res.json().catch(() => undefined);
      const ra = res.headers.get('Retry-After');
      throw classifyStatus(res.status, body, ra ? Number(ra) * 1000 : undefined);
    },
  };
}

export interface ServerReport {
  id: string;
  description: string;
  createdAt?: number;
  receivedAt: string;
  images: {url: string; bytes: number}[];
}

/** What the server actually holds. Deliberately separate from the local queue. */
export async function fetchServerReports(baseUrl: string, signal?: AbortSignal): Promise<ServerReport[]> {
  const res = await fetch(`${baseUrl}/reports`, {signal});
  if (!res.ok) throw new UploadError('transient', `Server responded ${res.status}`);
  return (await res.json()).reports;
}
