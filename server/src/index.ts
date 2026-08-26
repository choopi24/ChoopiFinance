import "./env.js"; // must be first — populates process.env before route modules evaluate
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
import { accountsRouter } from "./routes/accounts.js";
import { entriesRouter } from "./routes/entries.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { pricesRouter } from "./routes/prices.js";
import { fxRouter } from "./routes/fx.js";
import { rulesRouter } from "./routes/rules.js";
import { rsuRouter } from "./routes/rsu.js";
import { settingsRouter } from "./routes/settings.js";
import { searchRouter } from "./routes/search.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { takeSnapshot } from "./services/snapshot.js";
import { runBackup, hasRecentBackup } from "./services/backup.js";
import { generateDueDeposits } from "./services/rules.js";
import { recomputeAllAccruals } from "./services/fees.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
// Bound to all interfaces so the app is reachable from a phone on the same LAN.
// This is a private-network listener only — never expose it to the internet.
const HOST = "0.0.0.0";

// CSP is off because the bundled SPA uses inline styles; HSTS is irrelevant on
// plain-HTTP LAN.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: (_origin, cb) => cb(null, true), // LAN only — the auth cookie is the gate
  credentials: true,
}));
// 20mb: POST /api/settings/import receives a full JSON export of the ledger.
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

// Initialise DB + run migrations on startup
getDb();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/api/auth",      authRouter);
app.use("/api/system",    systemRouter);
app.use("/api/accounts",  accountsRouter);
app.use("/api/entries",   entriesRouter);
app.use("/api/portfolio", portfolioRouter);
app.use("/api/prices",    pricesRouter);
app.use("/api/fx",        fxRouter);
app.use("/api/rules",     rulesRouter);
app.use("/api/rsu",       rsuRouter);
app.use("/api/settings",  settingsRouter);
app.use("/api/search",    searchRouter);

app.use(errorHandler);

// ── Serve built client in production ─────────────────────────────────────────
const CLIENT_DIST = join(__dirname, "../../client/dist");
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => res.sendFile(join(CLIENT_DIST, "index.html")));
  console.log(`Serving static  →  ${CLIENT_DIST}`);
}

app.listen(PORT, HOST, () => {
  console.log(`Choopi server  →  http://${HOST}:${PORT}  (LAN only)`);
  console.log(`Health check   →  http://localhost:${PORT}/api/health`);
});

/**
 * Bring the ledger up to date: post any monthly deposits that have come due and
 * refresh fee estimates. Cheap and idempotent, so it runs on boot and daily —
 * a machine that sleeps through the cron still catches up next time it starts.
 */
function catchUp(reason: string): void {
  const db = getDb();
  const users = db.prepare("SELECT id FROM users").all() as { id: number }[];
  let posted = 0;
  for (const u of users) {
    posted += generateDueDeposits(db, u.id).created;
    recomputeAllAccruals(db, u.id);
    takeSnapshot(db, u.id);
  }
  if (users.length > 0) {
    console.log(`[${reason}] ${users.length} user(s), ${posted} scheduled deposit(s) posted`);
  }
}

catchUp("boot");

// Backup on boot, unless one was taken in the last 12h (keeps dev restarts from
// churning the retention window).
if (!hasRecentBackup(12)) {
  runBackup(getDb())
    .then(r => console.log(`[backup] ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch(err => console.error("[backup] boot backup failed:", (err as Error).message));
}

// ── Daily: catch up the ledger at 02:00, back up at 02:05 ────────────────────
cron.schedule("0 2 * * *", () => catchUp("cron"));

cron.schedule("5 2 * * *", () => {
  runBackup(getDb())
    .then(r => console.log(`[cron] Backup ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`))
    .catch(err => console.error("[cron] backup failed:", (err as Error).message));
});
