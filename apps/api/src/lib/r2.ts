// R2Adapter — object storage surface. Production binds the real R2 bucket;
// local dev uses the filesystem shim (apps/api/src/local/r2fs.ts).
// R2 is PRIVATE: there are no public URLs; downloads always go through
// the /stream route which validates the watch token first.

export interface R2GetResult {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  contentType?: string;
  etag?: string;
  /** Inclusive byte range that was served, when the caller asked for one. */
  range?: { start: number; end: number };
}

export interface R2Adapter {
  /** Store bytes under key. */
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer, opts?: { contentType?: string }): Promise<void>;
  /** Fetch bytes; honors HTTP-style Range. Returns null when the key is missing. */
  get(key: string, range?: { offset: number; length?: number }): Promise<R2GetResult | null>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

export function parseRangeHeader(
  rangeHeader: string | null | undefined, size: number
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  let start = (m[1] ?? '') === '' ? NaN : parseInt(m[1] as string, 10);
  let end = (m[2] ?? '') === '' ? NaN : parseInt(m[2] as string, 10);
  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    if (Number.isNaN(end)) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start >= size || end >= size || start > end) return null;
  return { start, end };
}
