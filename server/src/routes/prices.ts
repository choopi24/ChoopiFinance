import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { refreshPrice, batchRefreshAll } from "../services/prices.js";
import { takeSnapshot } from "../services/snapshot.js";

export const pricesRouter = Router();
pricesRouter.use(requireAuth);

// POST /api/prices/refresh — batch refresh all active positions
pricesRouter.post("/refresh", async (req, res) => {
  try {
    const db = getDb();
    const result = await batchRefreshAll(db, req.user!.id);
    // Snapshot after a full refresh so the chart gains a data point
    takeSnapshot(db, req.user!.id);
    ok(res, result);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/prices/refresh/:investmentId — single position refresh
pricesRouter.post("/refresh/:id", async (req, res) => {
  try {
    const db = getDb();
    const invId = Number(req.params.id);

    // Verify ownership
    const inv = db.prepare(
      "SELECT id FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(invId, req.user!.id);
    if (!inv) return fail(res, "Investment not found", 404);

    const result = await refreshPrice(db, invId);
    ok(res, result ?? { message: "No price available for this investment type" });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
