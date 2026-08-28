/**
 * Restore the live database from a backup.
 *
 *   npm run restore                                  list what's available
 *   npm run restore -- choopi-20260827-020500.db     restore that snapshot
 *   npm run restore -- choopi-20260827-020500.json   rebuild from the JSON
 *   npm run restore -- /absolute/path/to/backup.db
 *
 * STOP THE SERVER FIRST. The script takes an exclusive lock probe on the live
 * database and aborts if anything else holds it, so it cannot half-overwrite a
 * file the server is writing to.
 *
 * Order of operations, deliberately paranoid:
 *   1. lock probe — fails fast if the server is still running
 *   2. fingerprint the CURRENT database, so you can see what you replaced
 *   3. safety-copy the current database to data/backups/pre-restore-<ts>.db
 *   4. restore (file copy for .db, transactional re-import for .json)
 *   5. PRAGMA integrity_check
 *   6. print both fingerprints side by side
 *
 * Step 3 means a restore is itself undoable: if you restore the wrong night,
 * the state you just replaced is sitting in the backups directory.
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, readFileSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, isAbsolute, join } from "path";
import { BACKUPS_DIR, listBackups } from "../src/services/backup.js";
import { runMigrations } from "../src/db/migrate.js";
import { fingerprint, importExport, type ExportPayload } from "../src/services/ledgerExport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DB = join(__dirname, "../data/choopi.db");

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const kb = (n: number) => `${Math.round(n / 1024).toLocaleString()} KB`;

function showAvailable(): void {
  const entries = listBackups();
  if (!entries.length) {
    console.log(`\nNo backups in ${BACKUPS_DIR}\n`);
    return;
  }
  console.log(`\nBackups in ${BACKUPS_DIR}:\n`);
  for (const e of entries) {
    const when = e.takenAt.toLocaleString();
    console.log(
      `  ${e.db.padEnd(34)} ${when.padEnd(22)} ${kb(e.sizeBytes).padStart(10)}` +
      `${e.json ? "   + .json" : "   (no .json)"}`
    );
  }
  console.log(`\nRestore one with:\n  npm run restore -- ${entries[0].db}\n`);
}

/** Refuse to touch the file while the server still has it open. */
function assertServerStopped(): void {
  if (!existsSync(LIVE_DB)) return;
  let probe: Database.Database | null = null;
  try {
    probe = new Database(LIVE_DB);
    probe.pragma("locking_mode = EXCLUSIVE");
    probe.exec("BEGIN EXCLUSIVE; COMMIT;");
  } catch {
    die(
      "The database is in use — stop the server first.\n" +
      "  pm2:     pm2 stop choopi\n" +
      "  launchd: launchctl bootout gui/$(id -u)/com.choopi.finance\n" +
      "  npm:     Ctrl-C in the terminal running it"
    );
  } finally {
    probe?.close();
  }
}

function safetyCopy(): string | null {
  if (!existsSync(LIVE_DB)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dest = join(BACKUPS_DIR, `pre-restore-${stamp}.db`);
  copyFileSync(LIVE_DB, dest);
  return dest;
}

/** Remove the WAL sidecars, or SQLite will graft the old journal onto the new file. */
function clearSidecars(): void {
  for (const suffix of ["-wal", "-shm"]) {
    const f = `${LIVE_DB}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }
}

function fingerprintOf(path: string): Record<string, number> | null {
  if (!existsSync(path)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return fingerprint(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function compare(before: Record<string, number> | null, after: Record<string, number>): void {
  console.log("\n  what                        before        after");
  console.log("  ────────────────────────────────────────────────");
  for (const [key, value] of Object.entries(after)) {
    const prior = before?.[key];
    const changed = prior !== undefined && prior !== value;
    console.log(
      `  ${key.padEnd(26)} ${String(prior ?? "—").padStart(10)} ${String(value).padStart(12)}` +
      `${changed ? "   ←" : ""}`
    );
  }
}

const run = async (): Promise<void> => {
  const arg = process.argv[2];
  if (!arg) { showAvailable(); return; }

  const source = isAbsolute(arg) ? arg : join(BACKUPS_DIR, basename(arg));
  if (!existsSync(source)) die(`No such backup: ${source}`);

  assertServerStopped();

  const before = fingerprintOf(LIVE_DB);
  const saved = safetyCopy();
  if (saved) console.log(`\n  Current database saved to ${basename(saved)}`);

  if (source.endsWith(".json")) {
    // Rebuild from the text export: start from an empty, migrated database so
    // the restore never depends on whatever was in the live file.
    console.log(`  Rebuilding from JSON export ${basename(source)} …`);
    const payload = JSON.parse(readFileSync(source, "utf8")) as ExportPayload;

    clearSidecars();
    if (existsSync(LIVE_DB)) rmSync(LIVE_DB);

    const db = new Database(LIVE_DB);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    const { counts } = importExport(db, payload);
    db.close();

    console.log(`  Imported: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  } else {
    console.log(`  Copying ${basename(source)} over the live database …`);
    clearSidecars();
    copyFileSync(source, LIVE_DB);
  }

  // Integrity check on the result, not on the source: this is the file the
  // server will actually open.
  const check = new Database(LIVE_DB, { fileMustExist: true });
  const integrity = check.pragma("integrity_check", { simple: true });
  const after = fingerprint(check);
  check.close();

  if (integrity !== "ok") die(`Restored file failed its integrity check: ${integrity}`);

  console.log(`\n✓ Restored from ${basename(source)} — integrity check ok`);
  compare(before, after);
  console.log("\n  Start the server again and check the dashboard total.\n");
};

run().catch(err => die((err as Error).message));
