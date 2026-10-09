// DbAdapter over node:sqlite (Node 22.5+ built-in). Local-dev binding.
// Contract: batch() runs all statements in ONE transaction (BEGIN IMMEDIATE).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { DbAdapter, DbStatement, DbRunResult, DbAllResult } from '../lib/db.js';

class SqliteStatement implements DbStatement {
  private boundArgs: SQLInputValue[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]): DbStatement {
    this.boundArgs = args as SQLInputValue[];
    return this;
  }
  async all<T = Record<string, unknown>>(): Promise<DbAllResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.boundArgs) as T[];
    return { results, success: true };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.boundArgs) as T | undefined;
    return row ?? null;
  }
  async run(): Promise<DbRunResult> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.boundArgs);
    return { success: true, changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) };
  }
  /** Internal: run synchronously inside an explicit transaction. */
  runSync(): DbRunResult {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.boundArgs);
    return { success: true, changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) };
  }
}

export class SqliteAdapter implements DbAdapter {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string): DbStatement {
    return new SqliteStatement(this.db, sql);
  }
  async batch(statements: DbStatement[]): Promise<DbRunResult[]> {
    const results: DbRunResult[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of statements) {
        results.push((s as SqliteStatement).runSync());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}

export function openDatabase(path: string): SqliteAdapter {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return new SqliteAdapter(db);
}
