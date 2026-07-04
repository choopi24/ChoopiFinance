import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import cron from "node-cron";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "./db/init.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { authRouter } from "./routes/auth.js";
import { systemRouter } from "./routes/system.js";
import { investmentsRouter } from "./routes/investments.js";
import { transactionsRouter } from "./routes/transactions.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { realizedRouter } from "./routes/realized.js";
import { pricesRouter } from "./routes/prices.js";
import { fxRouter } from "./routes/fx.js";
import { settingsRouter } from "./routes/settings.js";
import { lookupRouter } from "./routes/lookup.js";
import { csvRouter } from "./routes/csv.js";
import { searchRouter } from "./routes/search.js";
import { ilFundsRouter } from "./routes/ilFunds.js";
import { rsuRouter } from "./routes/rsu.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { takeSnapshot } from "./services/snapshot.js";
import { getRate } from "./services/fx.js";
import { runBackup, hasRecentBackup } from "./services/backup.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const HOST = "0.0.0.0";

// Security headers. CSP is left off here because the bundled SPA relies on
// inline styles; tighten it separately if a policy is introduced.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: (_origin, cb) => cb(null, true), // LAN — security handled by auth cookie
  credentials: true,
}));
// 20mb: POST /api/settings/import receives a full JSON export of the ledger.
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

// Initialise DB + run migrations on startup
getDb();

// Warm the FX cache on boot (best-effort, non-blocking), then backfill missed
// daily snapshots — the 02:00 cron never fires on a machine that sleeps at
// night, so on boot snapshot any user without one in the last 20 hours.
getRate(getDb()).then(r => {
  console.log(`FX cache warm  →  1 USD = ${r.rate.toFixed(4)} NIS (${r.source})`);
}).catch(() => {
  console.warn("FX warm-up skipped (Frankfurter unreachable, will retry on first request)");
}).finally(() => {
  const db = getDb();
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const users = db.prepare(
    `SELECT id FROM users u
     WHERE NOT EXISTS (
       SELECT 1 FROM portfolio_snapshots s
       WHERE s.user_id = u.id AND s.snapshot_at >= ?
     )`
  ).all(cutoff) as { id: number }[];
  for (const u of users) takeSnapshot(db, u.id);
  if (users.length > 0) console.log(`[boot] Backfilled snapshots for ${users.length} user(s)`);

  // Boot backup — the cron below only fires if the machine is awake at 02:05.
  // Skipped when a backup from the last 12h exists, so rapid dev restarts
  // (tsx watch) don't churn the retention window.
  if (!hasRecentBackup(12)) {
    runBackup(db)
      .then(r => console.log(`[backup] ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
      .catch(err => console.error("[backup] boot backup failed:", (err as Error).message));
  }
});

// Routes
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/api/auth",         authRouter);
app.use("/api/system",       systemRouter);
app.use("/api/investments",  investmentsRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/portfolio",    portfolioRouter);
app.use("/api/realized",     realizedRouter);
app.use("/api/prices",       pricesRouter);
app.use("/api/fx",           fxRouter);
app.use("/api/settings",     settingsRouter);
app.use("/api/lookup",       lookupRouter);
app.use("/api/csv",          csvRouter);
app.use("/api/search",       searchRouter);
app.use("/api/il-funds",     ilFundsRouter);
app.use("/api/rsu",          rsuRouter);

app.use(errorHandler);

// ── Serve built client in production ─────────────────────────────────────────
const CLIENT_DIST = join(__dirname, "../../client/dist");
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => res.sendFile(join(CLIENT_DIST, "index.html")));
  console.log(`Serving static  →  ${CLIENT_DIST}`);
}

app.listen(PORT, HOST, () => {
  console.log(`Choopi server  →  http://${HOST}:${PORT}`);
  console.log(`Health check   →  http://localhost:${PORT}/api/health`);
});

// ── Daily portfolio snapshot at 02:00 local ───────────────────────────────────
cron.schedule("0 2 * * *", () => {
  console.log("[cron] Daily snapshot starting…");
  const db = getDb();
  const users = db.prepare("SELECT id FROM users").all() as { id: number }[];
  for (const u of users) {
    takeSnapshot(db, u.id);
  }
  console.log(`[cron] Snapshotted ${users.length} user(s)`);
});

// ── Daily DB backup at 02:05 local (WAL-safe hot copy + retention) ────────────
cron.schedule("5 2 * * *", () => {
  runBackup(getDb())
    .then(r => console.log(`[cron] Backup ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch(err => console.error("[cron] backup failed:", (err as Error).message));
});
