export const MAX_IMAGES = 5;
/** Hard ceiling at the destination. We aim well below it; see ImagePreparer. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ReportImage {
  index: number;
  /** App-private copy of what the user picked. Never the gallery URI. */
  originalUri: string;
  /** Downscaled/compressed file that is actually sent. */
  preparedUri?: string;
  preparedBytes?: number;
  /** How many times the server said "too large" for this image; drives harder compression. */
  compressionStep: number;
  /** Server has acknowledged this image's bytes. */
  uploaded: boolean;
}

/**
 * queued          saved on device, waiting (offline, backing off, or next in line)
 * uploading       a worker is sending it right now
 * uploaded        server committed it. The only phase that means "safe on the server"
 * needsAttention  will not retry on its own; user action required
 */
export type ReportPhase = 'queued' | 'uploading' | 'uploaded' | 'needsAttention';

export interface ReportError {
  message: string;
  at: number;
  /** Transient errors are being retried automatically; permanent ones need the user. */
  retrying: boolean;
}

export interface Report {
  /** Client-generated; doubles as the server idempotency key. */
  id: string;
  description: string;
  createdAt: number;
  images: ReportImage[];
  phase: ReportPhase;
  attempts: number;
  nextAttemptAt: number | null;
  lastError?: ReportError;
  committedAt?: number;
}

export interface ReportDraft {
  id: string;
  description: string;
  /** Local file URIs already copied into app-private storage. */
  imageUris: string[];
}

// ---- ports (implemented by the RN layer, faked in headless runs) -----------

export interface ReportStore {
  loadAll(): Promise<Report[]>;
  save(report: Report): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface UploadImageArgs {
  reportId: string;
  index: number;
  uri: string;
  bytes: number;
  signal: AbortSignal;
  /** Call on any forward progress so the stall watchdog resets. */
  onProgress: (sentBytes: number) => void;
}

export interface CommitArgs {
  id: string;
  description: string;
  imageCount: number;
  createdAt: number;
}

export interface ReportApi {
  uploadImage(args: UploadImageArgs): Promise<void>;
  commit(args: CommitArgs, signal: AbortSignal): Promise<void>;
}

export interface PreparedImage {
  uri: string;
  bytes: number;
}

export interface ImagePreparer {
  /** `step` > 0 means a previous result was rejected as too large: compress harder. */
  prepare(originalUri: string, step: number): Promise<PreparedImage>;
}

export interface FileOps {
  remove(uri: string): Promise<void>;
}
