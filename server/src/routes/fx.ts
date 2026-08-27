import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { getRate } from "../services/fx.js";

export const fxRouter = Router();
fxRouter.use(requireAuth);

// GET /api/fx/rate?from=USD&to=NIS
// Returns the stored USD→NIS rate (manual override, then fx_cache, then fallback).
// Nothing refreshes it from a provider any more.
fxRouter.get("/rate", async (req, res) => {
  try {
    const from = ((req.query.from as string) ?? "USD").toUpperCase();
    const to   = ((req.query.to   as string) ?? "NIS").toUpperCase();

    if (from !== "USD" || to !== "NIS") {
      return fail(res, "Only USD→NIS supported right now");
    }

    const result = await getRate(getDb(), req.user!.id);
    ok(res, { from, to, ...result });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
