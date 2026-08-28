import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "../db/migrate.js";
import {
  isBackupFilename, listBackups, runBackup, selectForPruning, type BackupEntry,
} from "./backup.js";
import { fingerprint, importExport, type ExportPayload } from "./ledgerExport.js";

/** A live ledger with one of everything the fingerprint counts. */
function seed(db: Database.Database): void {
  runMigrations(db);
  db.exec(`
    INSERT INTO accounts (name, category, valuation_mode, currency)
      VALUES ('Pension', 'pension', 'balance', 'ILS');
    INSERT INTO transactions (account_id, date, type, amount_minor, currency)
      VALUES (1, '2026-01-31', 'deposit', 250000, 'ILS');
    INSERT INTO transactions (account_id, date, type, amount_minor, currency, fee_kind)
      VALUES (1, '2026-01-31', 'fee', -1250, 'ILS', 'management_balance');
    INSERT INTO valuations (account_id, date, balance_minor, currency)
      VALUES (1, '2026-01-31', 260000, 'ILS');
  `);
}

describe("runBackup", () => {
  let dir: string;
  let backups: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "choopi-backup-"));
    backups = join(dir, "backups");
    db = new Database(join(dir, "live.db"));
    db.pragma("journal_mode = WAL");
    seed(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a snapshot and a JSON sidecar sharing one stem", async () => {
    const r = await runBackup(db, { dir: backups });

    expect(r.dbFile).toMatch(/^choopi-\d{8}-\d{6}\.db$/);
    expect(r.jsonFile).toBe(`${r.stem}.json`);
    expect(existsSync(join(backups, r.dbFile))).toBe(true);
    expect(existsSync(join(backups, r.jsonFile))).toBe(true);
    expect(r.integrityOk).toBe(true);
  });

  it("snapshots the live WAL database consistently", async () => {
    const r = await runBackup(db, { dir: backups });

    const copy = new Database(join(backups, r.dbFile), { readonly: true });
    const row = copy.prepare("SELECT SUM(amount_minor) v FROM transactions").get() as { v: number };
    expect(row.v).toBe(250000 - 1250);
    copy.close();
  });

  it("leaves no WAL sidecar next to the snapshot, so restoring is one file copy", async () => {
    const r = await runBackup(db, { dir: backups });
    const files = readdirSync(backups);
    expect(files).toContain(r.dbFile);
    expect(files.some(f => f.endsWith("-wal") || f.endsWith("-shm"))).toBe(false);
  });

  it("the JSON sidecar re-imports to the same numbers", async () => {
    const before = fingerprint(db);
    const r = await runBackup(db, { dir: backups });

    // Wipe the live ledger, then rebuild it from the sidecar alone.
    db.exec("DELETE FROM valuations; DELETE FROM transactions; DELETE FROM accounts;");
    expect(fingerprint(db).transactions).toBe(0);

    const payload = JSON.parse(readFileSync(join(backups, r.jsonFile), "utf8")) as ExportPayload;
    importExport(db, payload);

    expect(fingerprint(db)).toEqual(before);
  });

  it("two backups in the same second do not collide", async () => {
    const now = new Date(2026, 7, 27, 2, 5, 0);
    const a = await runBackup(db, { dir: backups, now });
    const b = await runBackup(db, { dir: backups, now });

    expect(b.stem).not.toBe(a.stem);
    expect(existsSync(join(backups, a.dbFile))).toBe(true);
    expect(existsSync(join(backups, b.dbFile))).toBe(true);
  });

  it("prunes the pair, never orphaning a sidecar", async () => {
    for (let d = 1; d <= 4; d++) {
      await runBackup(db, { dir: backups, now: new Date(2026, 0, d, 3, 0, 0), daily: 2, monthly: 0 });
    }
    const left = listBackups(backups);
    expect(left).toHaveLength(2);
    for (const entry of left) expect(entry.json).not.toBeNull();
  });
});

// ── retention ────────────────────────────────────────────────────────────────

/** Build entries the way listBackups would, without touching a disk. */
function entriesFor(stamps: string[]): BackupEntry[] {
  return stamps.map(stem => {
    const [, y, mo, d] = /^choopi-(\d{4})(\d{2})(\d{2})-/.exec(stem)!;
    return {
      stem,
      db: `${stem}.db`,
      json: `${stem}.json`,
      takenAt: new Date(`${y}-${mo}-${d}T02:05:00`),
      month: `${y}-${mo}`,
      day: `${y}-${mo}-${d}`,
      sizeBytes: 1024,
    };
  });
}

describe("selectForPruning", () => {
  it("keeps the newest N dailies", () => {
    const stamps = Array.from({ length: 10 }, (_, i) =>
      `choopi-202608${String(i + 1).padStart(2, "0")}-020500`);
    const doomed = selectForPruning(entriesFor(stamps), 3, 0).map(e => e.stem);

    expect(doomed).toHaveLength(7);
    expect(doomed).not.toContain("choopi-20260810-020500");
    expect(doomed).toContain("choopi-20260801-020500");
  });

  it("keeps one backup per month beyond the daily window", () => {
    const stamps = [
      "choopi-20260827-020500", "choopi-20260826-020500", // August
      "choopi-20260731-020500", "choopi-20260701-020500", // July
      "choopi-20260630-020500",                            // June
    ];
    const kept = new Set(entriesFor(stamps).map(e => e.stem));
    for (const e of selectForPruning(entriesFor(stamps), 1, 3)) kept.delete(e.stem);

    // Newest overall, plus the newest of July and June.
    expect([...kept].sort()).toEqual([
      "choopi-20260630-020500", "choopi-20260731-020500", "choopi-20260827-020500",
    ]);
  });

  it("keeps a month's NEWEST backup, not its oldest", () => {
    const stamps = ["choopi-20260731-020500", "choopi-20260715-020500", "choopi-20260701-020500"];
    const doomed = selectForPruning(entriesFor(stamps), 0, 1).map(e => e.stem);
    expect(doomed).toEqual(["choopi-20260715-020500", "choopi-20260701-020500"]);
  });

  it("drops nothing when everything fits", () => {
    const stamps = ["choopi-20260827-020500", "choopi-20260826-020500"];
    expect(selectForPruning(entriesFor(stamps), 30, 12)).toEqual([]);
  });

  it("stops counting months once the monthly budget is spent", () => {
    const stamps = Array.from({ length: 15 }, (_, i) => {
      const month = String(12 - (i % 12)).padStart(2, "0");
      const year = 2026 - Math.floor(i / 12);
      return `choopi-${year}${month}15-020500`;
    });
    const kept = entriesFor(stamps).length - selectForPruning(entriesFor(stamps), 0, 12).length;
    expect(kept).toBe(12);
  });
});

// ── download-path safety ─────────────────────────────────────────────────────

describe("isBackupFilename", () => {
  it("accepts exactly the names this module writes", () => {
    expect(isBackupFilename("choopi-20260827-020500.db")).toBe(true);
    expect(isBackupFilename("choopi-20260827-020500.json")).toBe(true);
    expect(isBackupFilename("choopi-20260827-020500-2.db")).toBe(true);
  });

  it("refuses anything that could walk out of the backups directory", () => {
    for (const bad of [
      "../../.env",
      "choopi-20260827-020500.db/../../../etc/passwd",
      "/etc/passwd",
      "..%2F.env",
      "choopi.db",
      "choopi-20260827-020500.txt",
      "choopi-20260827-020500",
    ]) {
      expect(isBackupFilename(bad), bad).toBe(false);
    }
  });
});
