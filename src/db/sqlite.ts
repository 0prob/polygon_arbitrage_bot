
/**
 * src/db/sqlite.js — small compatibility layer over node:sqlite
 *
 * The existing registry helpers expect a better-sqlite3-like API with:
 *   - db.prepare(sql).run/get/all(...)
 *   - db.exec(sql)
 *   - db.pragma("key = value")
 *   - db.transaction(fn)
 *
 * This adapter keeps that surface stable while using Node's built-in SQLite.
 */

import { DatabaseSync, StatementSync } from "node:sqlite";
type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class CompatStatement {
  statement: StatementSync;
  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  run(...params: SQLInputValue[]) {
    return this.statement.run(...params);
  }

  get(...params: SQLInputValue[]) {
    return this.statement.get(...params);
  }

  all(...params: SQLInputValue[]) {
    return this.statement.all(...params);
  }

  iterate(...params: SQLInputValue[]) {
    return this.statement.iterate(...params);
  }
}

export class CompatDatabase {
  db: DatabaseSync;
  _statementCache: Map<string, CompatStatement>;
  _namedStatementCache: Map<string, CompatStatement>;
  _namedStatementSql: Map<string, string>;
  _savepointId: number;
  _closed: boolean;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this._statementCache = new Map();
    this._namedStatementCache = new Map();
    this._namedStatementSql = new Map();
    this._savepointId = 0;
    this._closed = false;
  }

  prepare(sql: string) {
    if (this._closed) throw new Error("CompatDatabase: database is closed");
    if (!this._statementCache.has(sql)) {
      this._statementCache.set(sql, new CompatStatement(this.db.prepare(sql)));
    }
    return this._statementCache.get(sql)!;
  }

  statement(key: string, sql: string) {
    if (this._closed) throw new Error("CompatDatabase: database is closed");
    const cachedSql = this._namedStatementSql.get(key);
    if (cachedSql != null && cachedSql !== sql) {
      throw new Error(
        `CompatDatabase.statement key collision for "${key}": existing SQL does not match new SQL`,
      );
    }
    if (!this._namedStatementCache.has(key)) {
      this._namedStatementCache.set(key, this.prepare(sql));
      this._namedStatementSql.set(key, sql);
    }
    return this._namedStatementCache.get(key)!;
  }

  exec(sql: string) {
    if (this._closed) throw new Error("CompatDatabase: database is closed");
    return this.db.exec(sql);
  }

  pragma(sql: string) {
    return this.db.exec(`PRAGMA ${sql}`);
  }

  pragmaGet<T = Record<string, unknown>>(sql: string): T | undefined {
    return this.db.prepare(`PRAGMA ${sql}`).get() as T | undefined;
  }

  transaction(fn: (...args: unknown[]) => unknown) {
    return (...args: unknown[]) => {
      const nested = this.db.isTransaction;
      const savepoint = `sp_${++this._savepointId}`;

      if (nested) {
        this.db.exec(`SAVEPOINT ${savepoint}`);
      } else {
        this.db.exec("BEGIN IMMEDIATE");
      }

      try {
        const result = fn(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          throw new Error("CompatDatabase.transaction does not support async functions");
        }
        if (nested) {
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.db.exec("COMMIT");
        }
        return result;
      } catch (error) {
        if (nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.db.exec("ROLLBACK");
        }
        throw error;
      }
    };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._namedStatementSql.clear();
    this._namedStatementCache.clear();
    this._statementCache.clear();
    this.db.close();
  }
}
