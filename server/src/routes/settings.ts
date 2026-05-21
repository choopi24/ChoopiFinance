import { Router } from "express";
import bcrypt from "bcrypt";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { takeSnapshot } from "../services/snapshot.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const BCRYPT_ROUNDS = 12;

type UserRow = {
  display_currency: string;
  fx_override: number | null;
  theme: string;
  display_name: string | null;
  stay_signed_in: number;
  show_on_lock_screen: number;
};

// GET /api/settings
settingsRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const user = db
      .prepare<[number], UserRow>(
        `SELECT display_currency, fx_override, theme, display_name,
                stay_signed_in, show_on_lock_screen
         FROM users WHERE id = ?`
      )
      .get(req.user!.id);
    ok(res, user ?? {});
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/fx-override — set or clear manual FX rate
settingsRouter.patch("/fx-override", (req, res) => {
  try {
    const db = getDb();
    const { rate } = req.body as { rate: number | null | undefined };

    if (rate !== null && rate !== undefined) {
      const n = Number(rate);
      if (isNaN(n) || n <= 0 || n > 100) {
        return fail(res, "rate must be a positive number (e.g. 3.72)");
      }
      db.prepare("UPDATE users SET fx_override = ? WHERE id = ?").run(n, req.user!.id);
    } else {
      db.prepare("UPDATE users SET fx_override = NULL WHERE id = ?").run(req.user!.id);
    }

    const updated = db
      .prepare<[number], { display_currency: string; fx_override: number | null }>(
        "SELECT display_currency, fx_override FROM users WHERE id = ?"
      )
      .get(req.user!.id);
    ok(res, updated);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/display-currency
settingsRouter.patch("/display-currency", (req, res) => {
  try {
    const db = getDb();
    const { currency } = req.body as { currency?: string };
    if (currency !== "NIS" && currency !== "USD") {
      return fail(res, "currency must be NIS or USD");
    }
    db.prepare("UPDATE users SET display_currency = ? WHERE id = ?").run(currency, req.user!.id);
    ok(res, { display_currency: currency });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/theme
settingsRouter.patch("/theme", (req, res) => {
  try {
    const db = getDb();
    const { theme } = req.body as { theme?: string };
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      return fail(res, "theme must be light, dark, or system");
    }
    db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, req.user!.id);
    ok(res, { theme });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/display-name
settingsRouter.patch("/display-name", (req, res) => {
  try {
    const db = getDb();
    const { display_name } = req.body as { display_name?: string | null };
    const name = display_name?.trim() || null;
    if (name && name.length > 80) return fail(res, "Display name too long (max 80 chars)");
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, req.user!.id);
    ok(res, { display_name: name });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/password
settingsRouter.patch("/password", async (req, res) => {
  try {
    const db = getDb();
    const { current_password, new_password } = req.body as {
      current_password?: string;
      new_password?: string;
    };

    if (!current_password || !new_password) {
      return fail(res, "current_password and new_password are required");
    }
    if (new_password.length < 8) {
      return fail(res, "New password must be at least 8 characters");
    }

    const row = db
      .prepare<[number], { password_hash: string }>("SELECT password_hash FROM users WHERE id = ?")
      .get(req.user!.id);
    if (!row) return fail(res, "User not found", 404);

    const matched = await bcrypt.compare(current_password, row.password_hash);
    if (!matched) return fail(res, "Current password is incorrect", 403);

    const new_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(new_hash, req.user!.id);
    ok(res, { ok: true });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/settings/preferences — batch-update boolean preferences
settingsRouter.patch("/preferences", (req, res) => {
  try {
    const db = getDb();
    const { stay_signed_in, show_on_lock_screen } = req.body as {
      stay_signed_in?: boolean;
      show_on_lock_screen?: boolean;
    };

    const updates: string[] = [];
    const values: unknown[] = [];

    if (stay_signed_in !== undefined) {
      updates.push("stay_signed_in = ?");
      values.push(stay_signed_in ? 1 : 0);
    }
    if (show_on_lock_screen !== undefined) {
      updates.push("show_on_lock_screen = ?");
      values.push(show_on_lock_screen ? 1 : 0);
    }
    if (updates.length === 0) return fail(res, "No preferences to update");

    values.push(req.user!.id);
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    ok(res, { ok: true });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/settings/snapshot — trigger manual portfolio snapshot
settingsRouter.post("/snapshot", (req, res) => {
  try {
    const db = getDb();
    takeSnapshot(db, req.user!.id);
    ok(res, { ok: true, snapshot_at: new Date().toISOString() });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/settings/export — full JSON backup of user's ledger
settingsRouter.get("/export", (req, res) => {
  try {
    const db = getDb();
    const uid = req.user!.id;

    const user = db
      .prepare("SELECT id, username, display_name, display_currency, theme, created_at FROM users WHERE id = ?")
      .get(uid);

    const investments = db
      .prepare("SELECT * FROM investments WHERE user_id = ? ORDER BY created_at")
      .all(uid);

    const transactions = db
      .prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY occurred_at")
      .all(uid);

    const snapshots = db
      .prepare("SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY snapshot_at")
      .all(uid);

    const payload = {
      exported_at: new Date().toISOString(),
      schema_version: 1,
      user,
      investments,
      transactions,
      snapshots,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="choopi-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(payload);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/settings/data — wipe all investments + transactions (keeps user account)
settingsRouter.delete("/data", (req, res) => {
  try {
    const db = getDb();
    const uid = req.user!.id;
    const { confirm } = req.body as { confirm?: string };

    if (confirm !== "RESET") {
      return fail(res, 'confirm must equal "RESET"');
    }

    db.transaction(() => {
      db.prepare("DELETE FROM transactions WHERE user_id = ?").run(uid);
      db.prepare("DELETE FROM investments WHERE user_id = ?").run(uid);
      db.prepare("DELETE FROM portfolio_snapshots WHERE user_id = ?").run(uid);
    })();

    ok(res, { ok: true });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
