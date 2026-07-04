import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";

export const searchRouter = Router();
searchRouter.use(requireAuth);

const PAGES = [
  { id: "dashboard",    label: "Dashboard",     href: "/dashboard",    icon: "dashboard" },
  { id: "investments",  label: "Investments",   href: "/investments",  icon: "investments" },
  { id: "transactions", label: "Transactions",  href: "/transactions", icon: "transactions" },
  { id: "rsu",          label: "RSU Grants",    href: "/rsu",          icon: "investments" },
  { id: "realized",     label: "Realized P&L",  href: "/realized",     icon: "realized" },
  { id: "settings",     label: "Settings",      href: "/settings",     icon: "settings" },
];

// GET /api/search?q=
searchRouter.get("/", (req, res) => {
  try {
    const q = ((req.query.q as string) ?? "").trim();
    if (!q || q.length < 1) return ok(res, { investments: [], transactions: [], pages: [] });

    const db = getDb();
    const uid = req.user!.id;
    const like = `%${q}%`;

    const investments = db
      .prepare(
        `SELECT id, name, ticker, type, closed_at
         FROM investments
         WHERE user_id = ? AND deleted_at IS NULL
           AND (name LIKE ? OR ticker LIKE ?)
         ORDER BY closed_at IS NOT NULL, name
         LIMIT 8`
      )
      .all(uid, like, like) as {
        id: number; name: string; ticker: string | null; type: string; closed_at: string | null;
      }[];

    const transactions = db
      .prepare(
        `SELECT t.id, t.kind, t.occurred_at, t.total_amount, t.currency,
                i.name AS investment_name, i.type AS investment_type
         FROM transactions t
         JOIN investments i ON i.id = t.investment_id
         WHERE t.user_id = ? AND (i.name LIKE ? OR i.ticker LIKE ? OR t.notes LIKE ?)
         ORDER BY t.occurred_at DESC
         LIMIT 5`
      )
      .all(uid, like, like, like) as {
        id: number; kind: string; occurred_at: string;
        total_amount: number; currency: string;
        investment_name: string; investment_type: string;
      }[];

    const pages = PAGES.filter(p =>
      p.label.toLowerCase().includes(q.toLowerCase())
    );

    ok(res, { investments, transactions, pages });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
