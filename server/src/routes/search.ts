import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";

export const searchRouter = Router();
searchRouter.use(requireAuth);

const PAGES = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "accounts",  label: "Accounts",  href: "/accounts" },
  { id: "prices",    label: "Update prices", href: "/prices" },
  { id: "rsu",       label: "RSU grants", href: "/rsu" },
  { id: "settings",  label: "Settings",  href: "/settings" },
];

// GET /api/search?q=
searchRouter.get("/", (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) return ok(res, { accounts: [], pages: [] });

    const db = getDb();
    const like = `%${q}%`;

    const accounts = db.prepare(
      `SELECT id, name, kind, valuation_mode, currency, symbol FROM accounts
       WHERE user_id = ? AND archived_at IS NULL AND (name LIKE ? OR symbol LIKE ?)
       ORDER BY name COLLATE NOCASE LIMIT 8`
    ).all(req.user!.id, like, like);

    const pages = PAGES.filter(p => p.label.toLowerCase().includes(q.toLowerCase()));

    ok(res, { accounts, pages });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
