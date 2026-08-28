/**
 * GET /api/data/stale — accounts whose newest price or balance is older than
 * the configured threshold (override per request with ?days=).
 *
 * The dashboard's "needs attention" strip is the richer view of the same
 * facts; this endpoint is the plain list, kept at the spec's address so a
 * script or a shortcut can poll it without parsing UI concerns.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { staleAccounts } from "../calc/index.js";
import { calcOptions } from "./_context.js";
import { qDate, qInt } from "./_validate.js";

export const dataRouter = Router();
dataRouter.use(requireAuth);

dataRouter.get("/stale", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const days = qInt(req, "days", calcOptions(db).staleDataDays, 3650);
  ok(res, { as_of: asOf, threshold_days: days, accounts: staleAccounts(db, days, asOf) });
});
