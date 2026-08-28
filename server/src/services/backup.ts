/**
 * Nightly backups of the financial record.
 *
 * Each run writes a PAIR of files that share a stem:
 *
 *   backups/choopi-20260827-020500.db     VACUUM INTO snapshot
 *   backups/choopi-20260827-020500.json   full ledger as JSON
 *
 * Two formats on purpose. The .db restores in one file copy and is the fast
 * path. The .json is insurance against the .db becoming unreadable — a future
 * SQLite, a corrupted page, a machine you no longer own — because a text file
 * of your transactions can be read by anything, forever.
 *
 * VACUUM INTO rather than the online-backup API: it produces a defragmented,
 * fully-checkpointed database with no WAL sidecar, so a restore is a single
 * `cp` and never leaves a stale -wal next to the file. It takes a read lock for
 * the duration, which on a single-user ledger is milliseconds.
 *
 * Retention keeps the last 30 daily plus the last 12 monthly. A month's keeper
 * is its newest backup, so you always hold a year of month-ends and a month of
 * days — enough to recover from "I broke it last night" and from "I imported
 * the wrong CSV back in March" alike.
 */

import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import DatabaseCtor from "better-sqlite3";
import { buildExport } from "./ledgerExport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BACKUPS_DIR = join(__dirname, "../../data/backups");

const PREFIX = "choopi-";
const STEM_RE = /^choopi-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const keepDaily = () => envInt("BACKUP_KEEP_DAILY", KEEP_DAILY);
export const keepMonthly = () => envInt("BACKUP_KEEP_MONTHLY", KEEP_MONTHLY);

function stampFor(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${PREFIX}${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
         `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export interface BackupEntry {
  stem: string;
  db: string;
  json: string | null;
  /** Local time the snapshot was taken, parsed from the name. */
  takenAt: Date;
  /** "2026-08" — the retention bucket for the monthly tier. */
  month: string;
  day: string;
  sizeBytes: number;
}

/** Every backup on disk, newest first. */
export function listBackups(dir: string = BACKUPS_DIR): BackupEntry[] {
  if (!existsSync(dir)) return [];

  const entries: BackupEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".db")) continue;
    const stem = file.slice(0, -3);
    const m = STEM_RE.exec(stem);
    if (!m) continue;

    const [, y, mo, d, h, mi, s] = m.map(Number);
    const jsonName = `${stem}.json`;
    let sizeBytes = 0;
    try { sizeBytes = statSync(join(dir, file)).size; } catch { /* mid-delete */ }

    entries.push({
      stem,
      db: file,
      json: existsSync(join(dir, jsonName)) ? jsonName : null,
      takenAt: new Date(y, mo - 1, d, h, mi, s),
      month: `${m[1]}-${m[2]}`,
      day: `${m[1]}-${m[2]}-${m[3]}`,
      sizeBytes,
    });
  }

  return entries.sort((a, b) => b.stem.localeCompare(a.stem));
}

/**
 * Decide what survives: the newest `daily` snapshots, plus the newest snapshot
 * of each of the last `monthly` distinct months. Returns the ones to delete.
 */
export function selectForPruning(
  entries: BackupEntry[],
  daily = keepDaily(),
  monthly = keepMonthly()
): BackupEntry[] {
  const sorted = [...entries].sort((a, b) => b.stem.localeCompare(a.stem));
  const keep = new Set<string>();

  for (const e of sorted.slice(0, daily)) keep.add(e.stem);

  // `sorted` is newest-first, so the first sighting of a month IS that month's
  // newest backup — no second sort needed.
  const monthsSeen: string[] = [];
  for (const e of sorted) {
    if (monthsSeen.includes(e.month)) continue;
    monthsSeen.push(e.month);
    if (monthsSeen.length > monthly) break;
    keep.add(e.stem);
  }

  return sorted.filter(e => !keep.has(e.stem));
}

export interface BackupResult {
  stem: string;
  dbFile: string;
  jsonFile: string;
  sizeBytes: number;
  integrityOk: boolean;
  pruned: string[];
  durationMs: number;
}

/** Open the snapshot read-only and make SQLite check its own pages. */
function verifySnapshot(path: string): boolean {
  let probe: Database.Database | null = null;
  try {
    probe = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
    const row = probe.pragma("integrity_check", { simple: true });
    return row === "ok";
  } catch {
    return false;
  } finally {
    probe?.close();
  }
}

/**
 * Take one backup: snapshot, JSON sidecar, verify, prune.
 *
 * Throws if the snapshot fails or fails its integrity check — a backup that
 * silently didn't happen is worse than no backup at all, because you would
 * stop worrying about it.
 */
export async function runBackup(
  db: Database.Database,
  opts: { dir?: string; now?: Date; daily?: number; monthly?: number } = {}
): Promise<BackupResult> {
  const started = Date.now();
  const dir = opts.dir ?? BACKUPS_DIR;
  mkdirSync(dir, { recursive: true });

  // VACUUM INTO refuses to overwrite, so make the stem unique if a backup
  // already exists for this second (two clicks of "Back up now").
  let stem = stampFor(opts.now ?? new Date());
  let suffix = 1;
  while (existsSync(join(dir, `${stem}.db`))) stem = `${stampFor(opts.now ?? new Date())}-${++suffix}`;

  const dbPath = join(dir, `${stem}.db`);
  const jsonPath = join(dir, `${stem}.json`);

  // Single-quoted SQL literal; the stem is generated from a clock, never input.
  db.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);

  const integrityOk = verifySnapshot(dbPath);
  if (!integrityOk) {
    try { unlinkSync(dbPath); } catch { /* leave it if it won't go */ }
    throw new Error(`Backup ${stem}.db failed its integrity check and was discarded`);
  }

  writeFileSync(jsonPath, `${JSON.stringify(buildExport(db), null, 2)}\n`);

  const pruned: string[] = [];
  for (const old of selectForPruning(listBackups(dir), opts.daily, opts.monthly)) {
    for (const name of [old.db, old.json]) {
      if (!name) continue;
      try { unlinkSync(join(dir, name)); pruned.push(name); }
      catch { /* best effort — an undeletable old backup is not a failure */ }
    }
  }

  let sizeBytes = 0;
  try { sizeBytes = statSync(dbPath).size; } catch { /* raced with something */ }

  return {
    stem,
    dbFile: `${stem}.db`,
    jsonFile: `${stem}.json`,
    sizeBytes,
    integrityOk,
    pruned,
    durationMs: Date.now() - started,
  };
}

/**
 * True when the newest backup is younger than maxAgeHours. Used to skip the
 * boot backup on rapid dev restarts so retention isn't churned away by a day of
 * editing.
 */
export function hasRecentBackup(maxAgeHours: number, dir: string = BACKUPS_DIR): boolean {
  const newest = listBackups(dir)[0];
  if (!newest) return false;
  return Date.now() - newest.takenAt.getTime() < maxAgeHours * 3_600_000;
}

/** Guards the download endpoint: only ever a name this module could have written. */
export function isBackupFilename(name: string): boolean {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot);
  if (ext !== ".db" && ext !== ".json") return false;
  return /^choopi-\d{8}-\d{6}(-\d+)?$/.test(name.slice(0, dot));
}
