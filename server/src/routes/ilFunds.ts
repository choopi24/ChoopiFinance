import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { searchIlFunds, datasetForType, type IlDataset } from "../services/israelFunds.js";

export const ilFundsRouter = Router();
ilFundsRouter.use(requireAuth);

// GET /api/il-funds/search?q=<hebrew name>&type=<pension|gemel|education>
// Typeahead over the regulator datasets. Fails soft (returns []) — the user
// can always create the fund without a linkage and track it fully manually.
ilFundsRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const type = String(req.query.type ?? "");

  const dataset: IlDataset | null = datasetForType(type);
  if (!dataset) return fail(res, "type must be pension, gemel, or education");
  if (q.length < 2) return ok(res, []);

  try {
    const hits = await searchIlFunds(dataset, q);
    ok(res, hits);
  } catch {
    ok(res, []); // fail soft — non-critical convenience
  }
});
