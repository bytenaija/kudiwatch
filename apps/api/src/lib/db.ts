// DbAdapter — the D1-compatible surface our code programs against.
// In production (Workers) this wraps the real D1Database binding.
// Locally it wraps node:sqlite (apps/api/src/local/sqlite.ts).
// SQL must stay portable between the two: positional ? binds, no RETURNING.

export interface DbAllResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export interface DbRunResult {
  success: boolean;
  changes: number;
  lastRowId: number | bigint;
}

export interface DbStatement {
  bind(...args: unknown[]): DbStatement;
  all<T = Record<string, unknown>>(): Promise<DbAllResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<DbRunResult>;
}

export interface DbAdapter {
  prepare(sql: string): DbStatement;
  /** Runs all statements in a single transaction (D1.batch / BEGIN IMMEDIATE). */
  batch(statements: DbStatement[]): Promise<DbRunResult[]>;
  /** Raw multi-statement exec (migrations). */
  exec(sql: string): Promise<void>;
}

// Convenience helpers used across routes/libs.

export async function queryAll<T = Record<string, unknown>>(
  db: DbAdapter, sql: string, ...args: unknown[]
): Promise<T[]> {
  const r = await db.prepare(sql).bind(...args).all<T>();
  return r.results;
}

export async function queryOne<T = Record<string, unknown>>(
  db: DbAdapter, sql: string, ...args: unknown[]
): Promise<T | null> {
  return db.prepare(sql).bind(...args).first<T>();
}

export async function execRun(
  db: DbAdapter, sql: string, ...args: unknown[]
): Promise<DbRunResult> {
  return db.prepare(sql).bind(...args).run();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function uuid(): string {
  return crypto.randomUUID();
}
