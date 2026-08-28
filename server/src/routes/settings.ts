/**
 * App settings, plus the backup and export controls.
 *
 * Settings live in the `settings` key/value table, not on a user row: this is a
 * single-user app and "which currency do I read totals in" is a property of the
 * app, not of a login.
 */

import { Router } from "express";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import {
  BACKUPS_DIR, isBackupFilename, keepDaily, keepMonthly, listBackups, runBackup,
} from "../services/backup.js";
import {
  buildExport, fingerprint, importExport, LEDGER_TABLES, validateExport,
  type ExportPayload,
} from "../services/ledgerExport.js";
import { badRequest, HttpError } from "./_validate.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/**
 * The only keys that may be written, each with its own validator. A settings
 * table anyone can write arbitrary keys into becomes an untyped global object
 * within a month.
 */
const SETTINGS: Record<string, { fallback: string; validate: (v: string) => boolean; label: string }> = {
  display_currency: {
    fallback: "ILS", label: "Display currency",
    validate: v => v === "ILS" || v === "USD",
  },
  theme: {
    fallback: "system", label: "Theme",
    validate: v => ["light", "dark", "system"].includes(v),
  },
  rsu_principal_basis: {
    fallback: "zero_cost", label: "RSU cost basis",
    validate: v => v === "zero_cost" || v === "vest_price",
  },
  stale_data_days: {
    fallback: "45", label: "Stale data threshold (days)",
    validate: v => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365,
  },
  stale_fx_days: {
    fallback: "45", label: "Stale FX threshold (days)",
    validate: v => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365,
  },
  default_account_id: {
    fallback: "", label: "Quick-add default account",
    validate: v => v === "" || (Number.isInteger(Number(v)) && Number(v) > 0),
  },
};

function readAll() {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored = new Map(rows.map(r => [r.key, r.value]));
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(SETTINGS)) out[key] = stored.get(key) ?? spec.fallback;
  return out;
}

/** Newest backups, shaped for the Settings screen. */
function backupSummary(limit = 12) {
  const all = listBackups();
  return {
    total: all.length,
    keep_daily: keepDaily(),
    keep_monthly: keepMonthly(),
    latest: all[0]
      ? { ...all[0], takenAt: all[0].takenAt.toISOString() }
      : null,
    backups: all.slice(0, limit).map(b => ({
      stem: b.stem,
      db: b.db,
      json: b.json,
      taken_at: b.takenAt.toISOString(),
      size_bytes: b.sizeBytes,
    })),
  };
}

/** GET /api/settings */
settingsRouter.get("/", (_req, res) => {
  ok(res, { settings: readAll(), backups: backupSummary() });
});

/** PATCH /api/settings — accepts any subset of the known keys. */
settingsRouter.patch("/", (req, res) => {
  const db = getDb();
  const body = req.body as Record<string, unknown>;
  const write = db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const applied: string[] = [];
  db.transaction(() => {
    for (const [key, raw] of Object.entries(body)) {
      const spec = SETTINGS[key];
      if (!spec) throw badRequest(`Unknown setting "${key}"`);
      const value = raw == null ? "" : String(raw);
      if (!spec.validate(value)) throw badRequest(`Invalid value for ${spec.label}: "${value}"`);
      write.run(key, value);
      applied.push(key);
    }
  })();

  ok(res, { settings: readAll(), applied });
});

// ── backups ──────────────────────────────────────────────────────────────────

/** GET /api/settings/backups — the list behind the Settings panel. */
settingsRouter.get("/backups", (_req, res) => {
  ok(res, backupSummary(60));
});

/** POST /api/settings/backup — the "Back up now" button. */
settingsRouter.post("/backup", async (_req, res, next) => {
  try {
    ok(res, { ...(await runBackup(getDb())), ...backupSummary() }, 201);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/settings/backups/:file — download one backup file.
 *
 * The filename is checked against the exact pattern this server writes, so a
 * path can never escape the backups directory.
 */
settingsRouter.get("/backups/:file", (req, res) => {
  const file = req.params.file;
  if (!isBackupFilename(file)) throw badRequest("Not a backup filename");

  const full = join(BACKUPS_DIR, file);
  if (!existsSync(full)) throw new HttpError("That backup is no longer on disk", 404);

  res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
  res.setHeader("Content-Length", String(statSync(full).size));
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  res.sendFile(full);
});

/** GET /api/settings/fingerprint — row counts and money sums, for verifying a restore. */
settingsRouter.get("/fingerprint", (_req, res) => {
  ok(res, { fingerprint: fingerprint(getDb()) });
});

// ── export / import ──────────────────────────────────────────────────────────

/** GET /api/settings/export — a complete, re-importable JSON snapshot. */
settingsRouter.get("/export", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="choopi-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json(buildExport(getDb()));
});

/**
 * POST /api/settings/import — replace the ledger with an export.
 *
 * Takes a full backup first, so the state you are about to overwrite is on disk
 * before a single row is deleted.
 */
settingsRouter.post("/import", async (req, res, next) => {
  try {
    const db = getDb();
    const payload = req.body as ExportPayload;
    try {
      validateExport(payload);
    } catch (e) {
      throw badRequest((e as Error).message);
    }

    const backup = await runBackup(db);
    const { counts } = importExport(db, payload);
    ok(res, { ok: true, backup: backup.dbFile, imported: counts }, 201);
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/settings/data — wipe the ledger, keep settings. Backs up first. */
settingsRouter.delete("/data", async (req, res, next) => {
  try {
    const db = getDb();
    if ((req.body as { confirm?: string })?.confirm !== "RESET") {
      throw badRequest('confirm must equal "RESET"');
    }
    const backup = await runBackup(db);
    db.transaction(() => {
      db.pragma("foreign_keys = OFF");
      for (const t of [...LEDGER_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      db.pragma("foreign_keys = ON");
    })();
    ok(res, { ok: true, backup: backup.dbFile });
  } catch (e) {
    next(e);
  }
});
