/**
 * Migration runner.
 *
 * Applies every `NNN_name.sql` in server/migrations/ (lexicographic order) that
 * hasn't run yet, each inside ONE transaction. Because the runner owns the
 * transaction, migration files must NOT contain BEGIN/COMMIT — a failure rolls
 * the whole file back and leaves it unrecorded, so a fixed file re-runs cleanly.
 *
 * Applied files are fingerprinted. Editing a migration that already ran is a
 * hard error rather than a silent no-op: on a single-user app the DB in front of
 * you is the only copy, and a schema that silently diverges from its migration
 * history is how data gets corrupted.
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** server/migrations — resolves identically from src/db (dev) and dist/db (built). */
export const MIGRATIONS_DIR = join(__dirname, "../../migrations");

const FILE_PATTERN = /^\d{3,}_[\w-]+\.sql$/;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface AppliedMigration {
  version: string;
  checksum: string;
  applied_at: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * `dir` is overridable for tests only; production always uses MIGRATIONS_DIR.
 */
export function runMigrations(
  db: Database.Database,
  dir: string = MIGRATIONS_DIR
): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);

  if (!existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  const applied = new Map<string, AppliedMigration>(
    (db.prepare("SELECT version, checksum, applied_at FROM schema_migrations").all() as AppliedMigration[])
      .map(r => [r.version, r])
  );

  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (!FILE_PATTERN.test(f)) {
      throw new Error(`Migration filename must look like 001_init.sql — got "${f}"`);
    }
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)"
  );
  const result: MigrateResult = { applied: [], alreadyApplied: 0 };

  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const checksum = sha256(sql);
    const prior = applied.get(file);

    if (prior) {
      if (prior.checksum !== checksum) {
        throw new Error(
          `Migration ${file} changed after it was applied ` +
          `(recorded ${prior.checksum}, file is now ${checksum}). ` +
          `Applied migrations are immutable — add a new migration instead.`
        );
      }
      result.alreadyApplied++;
      continue;
    }

    if (/^\s*(BEGIN|COMMIT|END)\s*(TRANSACTION)?\s*;/im.test(sql)) {
      throw new Error(
        `Migration ${file} contains its own BEGIN/COMMIT — the runner manages ` +
        `the transaction. Remove them so a failure can roll back cleanly.`
      );
    }

    try {
      db.exec("BEGIN");
      db.exec(sql);
      record.run(file, checksum);
      db.exec("COMMIT");
      result.applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }

  return result;
}

/** Applied migrations, oldest first — handy for a health/debug endpoint. */
export function migrationStatus(db: Database.Database): AppliedMigration[] {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
  ).get();
  if (!exists) return [];
  return db.prepare(
    "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version"
  ).all() as AppliedMigration[];
}
