import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runMigrations } from "./migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(__dirname, "../../data/choopi.db");

let _db: Database.Database | null = null;

/**
 * Open (once) and return the database. Schema comes entirely from the versioned
 * migrations in server/migrations — there is no separate schema.sql to drift.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  // Referential integrity is off by default in SQLite and is per-connection.
  _db.pragma("foreign_keys = ON");
  // WAL: readers never block the writer — matters when the daily backup runs
  // while the app is live.
  _db.pragma("journal_mode = WAL");
  // Durable enough for a personal app, markedly faster than FULL.
  _db.pragma("synchronous = NORMAL");

  const { applied, alreadyApplied } = runMigrations(_db);
  console.log(
    `SQLite ready  →  ${DB_PATH}  ` +
    `(${alreadyApplied} migration(s) already applied${applied.length ? `, ${applied.length} new` : ""})`
  );
  return _db;
}

/** Close the handle — used by scripts so WAL is checkpointed on exit. */
export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
