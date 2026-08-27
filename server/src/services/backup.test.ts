import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBackup, listBackups } from "./backup.js";

// ── runBackup — consistent copy + retention ───────────────────────────────────

describe("runBackup", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "choopi-backup-"));
    db = new Database(join(dir, "live.db"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t VALUES ('hello')").run();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a consistent, openable copy while the source is live (WAL)", async () => {
    const r = await runBackup(db, { dir: join(dir, "backups") });
    expect(r.file).toMatch(/^choopi-\d{8}-\d{6}\.db$/);

    const copy = new Database(join(dir, "backups", r.file), { readonly: true });
    expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: "hello" });
    expect((copy.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check).toBe("ok");
    copy.close();
  });

  it("prunes to the newest N backups", async () => {
    const backups = join(dir, "backups");
    // Distinct timestamps so filenames don't collide.
    for (let i = 0; i < 5; i++) {
      await runBackup(db, { dir: backups, keep: 3, now: new Date(2026, 0, 1, 10, 0, i) });
    }
    const remaining = readdirSync(backups).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining[0]).toContain("100002"); // two oldest pruned
    expect(listBackups(backups)[0]).toContain("100004"); // newest first
  });
});
