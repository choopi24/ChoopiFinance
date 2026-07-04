/**
 * Automated SQLite backups.
 *
 * Uses better-sqlite3's native db.backup() — the SQLite Online Backup API —
 * which produces a consistent copy even while the DB is live in WAL mode.
 * Backups land in server/data/backups/choopi-YYYYMMDD-HHMMSS.db and only the
 * newest BACKUP_KEEP (default 14) are retained.
 *
 * Triggered from index.ts: once on boot and daily at 02:05 via node-cron.
 * Restore: `npm run restore -- <backup-file>` (see scripts/restore.ts).
 */

import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BACKUPS_DIR = join(__dirname, "../../data/backups");

const BACKUP_PREFIX = "choopi-";
const DEFAULT_KEEP = 14;

export function backupKeepCount(): number {
  const n = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP;
}

function timestampName(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${BACKUP_PREFIX}${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
         `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.db`;
}

/** Timestamped backup files, newest first (names sort chronologically). */
export function listBackups(dir: string = BACKUPS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db"))
    .sort()
    .reverse();
}

export interface BackupResult {
  file: string;
  pruned: string[];
}

/**
 * True when the newest backup is younger than maxAgeHours. Used to skip the
 * boot backup on rapid dev restarts (tsx watch) so retention isn't churned
 * away by a day of editing.
 */
export function hasRecentBackup(maxAgeHours: number, dir: string = BACKUPS_DIR): boolean {
  const newest = listBackups(dir)[0];
  if (!newest) return false;
  const m = newest.match(/^choopi-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const age = Date.now() - new Date(y, mo - 1, d, h, mi, s).getTime();
  return age < maxAgeHours * 60 * 60 * 1000;
}

/**
 * Write a consistent hot copy of the live DB and prune old backups down to
 * `keep`. Never throws on prune errors (a failed delete shouldn't fail the
 * backup); the backup itself throws on failure so callers can log it.
 */
export async function runBackup(
  db: Database.Database,
  opts: { dir?: string; keep?: number; now?: Date } = {}
): Promise<BackupResult> {
  const dir = opts.dir ?? BACKUPS_DIR;
  const keep = opts.keep ?? backupKeepCount();
  mkdirSync(dir, { recursive: true });

  const file = timestampName(opts.now);
  await db.backup(join(dir, file));

  const pruned: string[] = [];
  for (const old of listBackups(dir).slice(keep)) {
    try {
      unlinkSync(join(dir, old));
      pruned.push(old);
    } catch { /* best effort — an undeletable old backup is not a failure */ }
  }

  return { file, pruned };
}
