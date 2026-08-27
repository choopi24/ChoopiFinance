/**
 * App settings, plus whole-database export / import / backup.
 *
 * Settings live in the `settings` key/value table, not on the user row: this is
 * a single-user app and "which currency do I read totals in" is a property of
 * the app, not of a login.
 */

import { Router } from "express";
import bcrypt from "bcrypt";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { runBackup, listBackups } from "../services/backup.js";
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

/** GET /api/settings */
settingsRouter.get("/", (_req, res) => {
  ok(res, { settings: readAll(), backups: listBackups().slice(0, 10) });
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

/** PATCH /api/settings/password */
settingsRouter.patch("/password", async (req, res, next) => {
  try {
    const db = getDb();
    const { current_password, new_password } = req.body as {
      current_password?: string; new_password?: string;
    };
    if (!current_password || !new_password) {
      throw badRequest("current_password and new_password are required");
    }
    if (new_password.length < 8) throw badRequest("New password must be at least 8 characters");

    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(req.user!.id) as { password_hash: string } | undefined;
    if (!row) throw new HttpError("User not found", 404);
    if (!(await bcrypt.compare(current_password, row.password_hash))) {
      throw new HttpError("Current password is incorrect", 403);
    }

    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(await bcrypt.hash(new_password, 12), req.user!.id);
    ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

// ── whole-ledger export / import ─────────────────────────────────────────────

const LEDGER_TABLES = [
  "accounts", "holdings", "prices", "recurring_rules", "transactions",
  "valuations", "fx_rates", "rsu_grants", "rsu_vests",
] as const;

/** GET /api/settings/export — a complete, re-importable JSON snapshot. */
settingsRouter.get("/export", (_req, res) => {
  const db = getDb();
  const tables: Record<string, unknown[]> = {};
  for (const t of LEDGER_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();

  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="choopi-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json({
    format: "choopi-ledger",
    schema_version: 3,
    exported_at: new Date().toISOString(),
    settings: readAll(),
    tables,
  });
});

/**
 * POST /api/settings/import — replace the ledger with an export.
 *
 * Takes a native DB backup first, then swaps everything inside one transaction
 * with the original ids preserved, so foreign keys inside the payload stay
 * valid without any remapping pass.
 */
settingsRouter.post("/import", async (req, res, next) => {
  try {
    const db = getDb();
    const payload = req.body as {
      format?: string; tables?: Record<string, Record<string, unknown>[]>;
      settings?: Record<string, string>;
    };
    if (payload?.format !== "choopi-ledger" || !payload.tables) {
      throw badRequest("Not a Choopi ledger export");
    }

    const backup = await runBackup(db);
    const counts: Record<string, number> = {};

    db.transaction(() => {
      db.pragma("foreign_keys = OFF");
      // Children first on the way out, parents first on the way in.
      for (const t of [...LEDGER_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();

      for (const table of LEDGER_TABLES) {
        const rows = payload.tables![table] ?? [];
        counts[table] = rows.length;
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const stmt = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`
        );
        for (const row of rows) stmt.run(row);
      }

      if (payload.settings) {
        const write = db.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`
        );
        for (const [k, v] of Object.entries(payload.settings)) {
          if (SETTINGS[k]) write.run(k, String(v));
        }
      }
      db.pragma("foreign_keys = ON");
    })();

    ok(res, { ok: true, backup: backup.file, imported: counts }, 201);
  } catch (e) {
    next(e);
  }
});

/** POST /api/settings/backup — the manual backup button. */
settingsRouter.post("/backup", async (_req, res, next) => {
  try {
    const result = await runBackup(getDb());
    ok(res, { ...result, backups: listBackups().slice(0, 10) }, 201);
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/settings/data — wipe the ledger, keep the login and settings. */
settingsRouter.delete("/data", (req, res) => {
  const db = getDb();
  if ((req.body as { confirm?: string })?.confirm !== "RESET") {
    throw badRequest('confirm must equal "RESET"');
  }
  db.transaction(() => {
    db.pragma("foreign_keys = OFF");
    for (const t of [...LEDGER_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma("foreign_keys = ON");
  })();
  ok(res, { ok: true });
});
