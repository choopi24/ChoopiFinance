/**
 * Restore the live SQLite DB from a backup file.
 *
 *   npm run restore -- choopi-20260704-020500.db    (name inside data/backups/)
 *   npm run restore -- /absolute/path/to/backup.db
 *   npm run restore                                  (lists available backups)
 *
 * STOP THE SERVER FIRST (Ctrl-C `npm run dev`, or stop the production
 * process). The script refuses to run while another process holds the DB:
 * it takes a short exclusive lock probe and aborts on SQLITE_BUSY.
 *
 * What it does, in order:
 *   1. exclusive-lock probe on the live DB (fails fast if the server is up)
 *   2. safety-copies the current live DB to data/backups/pre-restore-<ts>.db
 *   3. copies the chosen backup over data/choopi.db (removing -wal/-shm)
 *   4. runs PRAGMA integrity_check on the result
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, isAbsolute, join } from "path";
import { BACKUPS_DIR, listBackups } from "../src/services/backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DB = join(__dirname, "../data/choopi.db");

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const arg = process.argv[2];

if (!arg) {
  const backups = listBackups();
  console.log("\nUsage: npm run restore -- <backup-file>\n");
  console.log(backups.length ? "Available backups (newest first):" : "No backups found yet.");
  for (const b of backups) console.log(`  ${b}`);
  console.log("");
  process.exit(0);
}

const source = isAbsolute(arg) ? arg : join(BACKUPS_DIR, arg);
if (!existsSync(source)) die(`Backup not found: ${source}`);
if (!existsSync(LIVE_DB)) die(`Live DB not found at ${LIVE_DB}`);

// 1a. Refuse while the Choopi server is running. An exclusive-lock probe alone
// is NOT enough: in WAL mode the idle server holds no write lock, so the probe
// succeeds while its open handles would be yanked out from under it.
const PORT = Number(process.env.PORT ?? 3001);
try {
  const resp = await fetch(`http://localhost:${PORT}/api/health`, {
    signal: AbortSignal.timeout(700),
  });
  if (resp.ok) {
    die(`The Choopi server is running on port ${PORT} — stop it first (Ctrl-C \`npm run dev\`), then re-run.`);
  }
} catch { /* connection refused / timeout = server down, good */ }

// 1b. Guard against any other process holding a write transaction.
let live: InstanceType<typeof Database>;
try {
  live = new Database(LIVE_DB, { timeout: 500 });
  live.exec("BEGIN EXCLUSIVE");
  live.exec("ROLLBACK");
} catch {
  die("The database is in use by another process — close it, then re-run.");
}

// 2. Safety-copy the current live DB before touching anything.
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const safety = `pre-restore-${stamp}.db`;
try {
  // db.backup gives a consistent copy even if a stray -wal exists.
  await live.backup(join(BACKUPS_DIR, safety));
} catch (e) {
  die(`Could not safety-copy the live DB: ${(e as Error).message}`);
} finally {
  live.close();
}

// 3. Replace the live DB with the chosen backup.
copyFileSync(source, LIVE_DB);
rmSync(`${LIVE_DB}-wal`, { force: true });
rmSync(`${LIVE_DB}-shm`, { force: true });

// 4. Verify.
const restored = new Database(LIVE_DB);
const check = restored.pragma("integrity_check") as { integrity_check: string }[];
const users = (restored.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
const invs = (restored.prepare("SELECT COUNT(*) n FROM investments").get() as { n: number }).n;
restored.close();

if (check[0]?.integrity_check !== "ok") die(`Integrity check FAILED: ${JSON.stringify(check)}`);

console.log(`
✓ Restored ${basename(source)} → data/choopi.db
  integrity_check: ok · ${users} user(s) · ${invs} investment(s)
  The previous live DB was saved as data/backups/${safety}

Start the server again with: npm run dev  (or npm start)
`);
