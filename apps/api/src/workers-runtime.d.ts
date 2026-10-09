// Minimal ambient declarations for the Cloudflare Workers runtime types used by
// the production bindings (workers.ts / prod-bindings.ts). Local dev never
// touches these; they exist so `tsc --noEmit` passes without @cloudflare/workers-types.
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number | string; [k: string]: unknown };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<unknown>;
}
interface R2Range { offset: number; length?: number }
interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
  range?: { offset: number; length: number };
}
interface R2ObjectHead {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}
interface R2Bucket {
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  head(key: string): Promise<R2ObjectHead | null>;
  delete(key: string): Promise<void>;
}
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}
