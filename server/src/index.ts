import "./env.js"; // must be first — populates process.env before route modules evaluate
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { getDb } from "./db/init.js";
import { recurring, rsu, today } from "./calc/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { runBackup, hasRecentBackup } from "./services/backup.js";

import { authRouter } from "./routes/auth.js";
import { systemRouter } from "./routes/system.js";
import { accountsRouter, holdingsRouter } from "./routes/accounts.js";
import { transactionsRouter } from "./routes/transactions.js";
import { pricesRouter, valuationsRouter } from "./routes/prices.js";
import { fxRouter } from "./routes/fx.js";
import { recurringRouter } from "./routes/recurring.js";
import { rsuRouter } from "./routes/rsu.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { settingsRouter } from "./routes/settings.js";
import { csvRouter } from "./routes/csv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const HOST = "0.0.0.0"; // LAN-reachable. Never put this behind a public tunnel.

// The client is same-origin static files, so there is no CORS to configure and
// no cross-origin request this app should ever accept.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      // No feeds, no CDNs, no analytics: the page may talk to this server only.
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // Plain HTTP on a home network — HSTS would poison the browser for the host.
  hsts: false,
  crossOriginOpenerPolicy: false,
}));
app.use(express.json({ limit: "20mb" })); // a full ledger import travels as JSON
app.use(cookieParser());

const db = getDb();

/**
 * Catch-up work, run on boot and again daily: post any salary deposits the
 * rules owe, and flip vests whose date has arrived. Both are idempotent, so a
 * machine that was asleep for a week catches up correctly on wake.
 */
function catchUp(label: string): void {
  try {
    const posted = recurring.generateDue(db, today());
    const vested = rsu.markVested(db, today());
    if (posted.created || vested) {
      console.log(`[${label}] posted ${posted.created} recurring deposit(s), vested ${vested} tranche(s)`);
    }
  } catch (err) {
    console.error(`[${label}] catch-up failed:`, (err as Error).message);
  }
}
catchUp("boot");

if (!hasRecentBackup(12)) {
  runBackup(db)
    .then(r => console.log(`[backup] ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch(err => console.error("[backup] boot backup failed:", (err as Error).message));
}

app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { ok: true, ts: new Date().toISOString() } });
});

app.use("/api/auth", authRouter);
app.use("/api/system", systemRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/holdings", holdingsRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/prices", pricesRouter);
app.use("/api/valuations", valuationsRouter);
app.use("/api/fx", fxRouter);
app.use("/api/recurring", recurringRouter);
app.use("/api/rsu", rsuRouter);
app.use("/api/portfolio", portfolioRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/csv", csvRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ success: false, error: "No such endpoint" });
});

app.use(errorHandler);

// ── the client ───────────────────────────────────────────────────────────────
// Plain static files: no bundler, no build step, nothing to rebuild after an
// edit. One process serves the API and the app on one port, which is what makes
// the phone URL a single `http://<lan-ip>:3001`.
const WEB_DIR = join(__dirname, "../../web");
if (existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR, { extensions: ["html"] }));
  app.get("*", (_req, res) => res.sendFile(join(WEB_DIR, "index.html")));
  console.log(`Serving app     →  ${WEB_DIR}`);
} else {
  console.warn(`No web directory at ${WEB_DIR} — API only.`);
}

app.listen(PORT, HOST, () => {
  console.log(`Choopi server   →  http://localhost:${PORT}`);
});

// Daily: 02:05 backup, 02:10 catch-up.
cron.schedule("5 2 * * *", () => {
  runBackup(db)
    .then(r => console.log(`[cron] backup ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch(err => console.error("[cron] backup failed:", (err as Error).message));
});
cron.schedule("10 2 * * *", () => catchUp("cron"));
