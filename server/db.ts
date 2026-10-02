import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { config } from './config';
export interface Database { query<T = Record<string, any>>(sql: string, params?: any[]): Promise<{ rows: T[] }>; close(): Promise<void>; }
export async function openDatabase(url = config.DATABASE_URL, directory = '.data/postgres'): Promise<Database> {
  if (url) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, query_timeout: 15000 });
    let connected = false;
    client.on('error', () => { connected = false; });
    await client.connect();
    // One durable coordinator owns all game and financial transitions.
    const lock = await client.query('SELECT pg_try_advisory_lock(713531923) AS acquired');
    if (!lock.rows[0].acquired) { await client.end(); throw new Error('Another Ticksy coordinator is already running.'); }
    connected = true;
    // A pool can silently reconnect without owning the session advisory lock.
    // Stop all state changes after connection loss; restart and reconcile instead.
    return { query: async <T>(sql: string, params?: any[]) => {
      if (!connected) throw new Error('Database coordinator connection lost. Restart to reconcile.');
      return { rows: (await client.query(sql, params)).rows as T[] };
    }, close: async () => { connected = false; await client.end(); } };
  }
  if (directory !== 'memory://') await mkdir(directory, { recursive: true });
  const database = new PGlite(directory);
  await database.waitReady;
  return { query: async (sql, params) => database.query(sql, params), close: () => database.close() };
}
export async function migrate(db: Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS players (wallet TEXT PRIMARY KEY, name TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES players(wallet), expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, number BIGSERIAL UNIQUE, status TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS one_unsettled_round ON rounds((1)) WHERE status NOT IN ('complete','cancelled')`,
    `CREATE TABLE IF NOT EXISTS reservations (round_id TEXT PRIMARY KEY REFERENCES rounds(id), amount_micros BIGINT NOT NULL CHECK(amount_micros>0), day BIGINT NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','spent','released')))`,
    `CREATE TABLE IF NOT EXISTS treasury_days (day BIGINT PRIMARY KEY, base_micros BIGINT NOT NULL CHECK(base_micros>=0))`,
    `CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, round_id TEXT NOT NULL UNIQUE REFERENCES rounds(id), winner TEXT NOT NULL, kind TEXT NOT NULL, amount_micros BIGINT NOT NULL DEFAULT 0, mint TEXT, signature TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS prizes (id TEXT PRIMARY KEY, mint TEXT NOT NULL, data JSONB NOT NULL, round_id TEXT, winner TEXT, status TEXT NOT NULL, transfer_signature TEXT)`,
    `ALTER TABLE prizes DROP CONSTRAINT IF EXISTS prizes_mint_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS one_award_per_round ON prizes(round_id) WHERE winner IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount_micros BIGINT NOT NULL, signature TEXT, created_at BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS audit (id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_income_signature ON ledger(signature) WHERE kind IN ('fee','seed')`,
  ];
  for (const statement of statements) await db.query(statement);
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= 256) return Promise.reject(Object.assign(new Error('The arena is busy. Try again shortly.'), { statusCode: 503 }));
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => { this.pending--; }); this.tail = next.catch(() => {}); return next;
  }
}
export async function atomic<T>(db: Database, fn: () => Promise<T>) { await db.query('BEGIN'); try { const result = await fn(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; } }
export const audit = (db: Database, event: string, data: unknown) => db.query('INSERT INTO audit(event,data,created_at) VALUES($1,$2,$3)', [event, JSON.stringify(data), Date.now()]);
