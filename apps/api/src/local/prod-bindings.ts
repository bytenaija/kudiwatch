// Production bindings: thin D1Database/R2Bucket → DbAdapter/R2Adapter wrappers.
// Only imported by apps/api/src/workers.ts (never in local dev).
import type { DbAdapter, DbStatement, DbRunResult, DbAllResult } from '../lib/db.js';
import type { R2Adapter, R2GetResult } from '../lib/r2.js';

class D1Statement implements DbStatement {
  private stmt: D1PreparedStatement;
  constructor(stmt: D1PreparedStatement) { this.stmt = stmt; }
  bind(...args: unknown[]): DbStatement {
    this.stmt = this.stmt.bind(...args);
    return this;
  }
  async all<T = Record<string, unknown>>(): Promise<DbAllResult<T>> {
    const r = await this.stmt.all<T>();
    return { results: r.results ?? [], success: r.success };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (await this.stmt.first<T>()) ?? null;
  }
  async run(): Promise<DbRunResult> {
    const r = await this.stmt.run();
    return { success: r.success, changes: r.meta.changes ?? 0, lastRowId: Number(r.meta.last_row_id ?? 0) };
  }
  /** Exposed for batch(). */
  get inner(): D1PreparedStatement { return this.stmt; }
}

export class D1Adapter implements DbAdapter {
  constructor(private d1: D1Database) {}
  prepare(sql: string): DbStatement {
    return new D1Statement(this.d1.prepare(sql));
  }
  async batch(statements: DbStatement[]): Promise<DbRunResult[]> {
    // D1.batch is atomic (all-or-nothing).
    const inner = statements.map((s) => (s as D1Statement).inner);
    const results = await this.d1.batch(inner);
    return results.map((r) => ({
      success: r.success, changes: r.meta.changes ?? 0, lastRowId: Number(r.meta.last_row_id ?? 0),
    }));
  }
  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }
}

export class R2BucketAdapter implements R2Adapter {
  constructor(private bucket: R2Bucket) {}
  async put(key: string, body: ReadableStream | Uint8Array | ArrayBuffer, opts?: { contentType?: string }): Promise<void> {
    await this.bucket.put(key, body as unknown as ReadableStream, {
      httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
    });
  }
  async get(key: string, range?: { offset: number; length?: number }): Promise<R2GetResult | null> {
    const obj = range
      ? await this.bucket.get(key, { range: { offset: range.offset, length: range.length } })
      : await this.bucket.get(key);
    if (!obj) return null;
    return {
      body: obj.body as unknown as ReadableStream<Uint8Array>,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType,
      etag: obj.etag,
      range: obj.range ? { start: obj.range.offset, end: obj.range.offset + obj.range.length - 1 } : undefined,
    };
  }
  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    const h = await this.bucket.head(key);
    if (!h) return null;
    return { size: h.size, contentType: h.httpMetadata?.contentType };
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
