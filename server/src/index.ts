import "./env.js"; // must be first — populates process.env before route modules evaluate
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import http from "http";
import https from "https";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { getDb, DB_PATH } from "./db/init.js";
import { recurring, rsu, today } from "./calc/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { setCookieSecure } from "./middleware/requireAuth.js";
import { runBackup, hasRecentBackup } from "./services/backup.js";
import { lanGuard, lanGuardConfig } from "./net/lanGuard.js";
import { caPath, hasCa, loadTls, primaryLanAddress } from "./net/tls.js";
import { renderBanner } from "./net/banner.js";
import { isPinConfigured, pinIsFromEnv } from "./security/pin.js";

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
import { dataRouter } from "./routes/data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3001);
/** Bound to every interface so the phone can reach it. NEVER port-forward this. */
const HOST = process.env.BIND_HOST ?? "0.0.0.0";
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);

const tls = loadTls();
const guard = lanGuardConfig();

// A Secure cookie over http:// is silently never sent, which looks exactly like
// a broken login — so the flag follows what we are actually serving.
setCookieSecure(tls !== null);

const app = express();

// Nothing is trusted about proxy headers: the LAN guard reads the socket, and
// req.ip must not be steerable by a header either.
app.set("trust proxy", false);
app.disable("x-powered-by");

// First in the stack, before anything parses a body or touches the database.
app.use(lanGuard({
  ...guard,
  onReject: (ip, path) => console.warn(`[lan-guard] refused ${ip} → ${path}`),
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      // No feeds, no CDNs, no analytics: the page may talk to this server only.
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      // Belt and braces against a stray absolute URL ever being requested.
      formAction: ["'self'"],
      baseUri: ["'self'"],
      // Helmet adds upgrade-insecure-requests by default. Here it is actively
      // harmful: on plain HTTP it rewrites same-origin subresource fetches to
      // https:// — including the service-worker script — against a port that
      // isn't listening, so the app half-loads with no explanation. When TLS is
      // on, every URL is already https and the directive buys nothing.
      upgradeInsecureRequests: null,
    },
  },
  // No HSTS: the certificate is a local one, and pinning HTTPS for this host in
  // every browser on the network would be a nuisance to undo.
  hsts: false,
  crossOriginOpenerPolicy: false,
}));

app.use(express.json({ limit: "20mb" })); // a full ledger import travels as JSON
app.use(cookieParser());

const db = getDb();

/**
 * Catch-up work, run on boot and again nightly: post any salary deposits the
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
    .then(r => console.log(
      `[backup] ${r.dbFile} + ${r.jsonFile} (${Math.round(r.sizeBytes / 1024)} KB, ${r.durationMs}ms)` +
      `${r.pruned.length ? `, pruned ${r.pruned.length}` : ""}`
    ))
    .catch(err => console.error("[backup] boot backup FAILED:", (err as Error).message));
}

app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { ok: true, ts: new Date().toISOString(), tls: tls !== null } });
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
// The spec's spellings for bulk CSV — same router, so /api/export/csv/prices
// and /api/import/csv/prices work alongside /api/csv/prices.
app.use("/api/export/csv", csvRouter);
app.use("/api/import/csv", csvRouter);
app.use("/api/data", dataRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ success: false, error: "No such endpoint" });
});

app.use(errorHandler);

// ── the client ───────────────────────────────────────────────────────────────
// Plain static files: no bundler, no build step, nothing to rebuild after an
// edit. One process serves the API and the app on one port, which is what makes
// the phone URL a single address.
const WEB_DIR = join(__dirname, "../../web");
if (existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR, {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      // The service worker and the manifest must never be served from a stale
      // cache, or a bad deploy pins itself in place on every installed phone.
      if (/(?:sw\.js|manifest\.webmanifest)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    },
  }));
  app.get("*", (_req, res) => res.sendFile(join(WEB_DIR, "index.html")));
} else {
  console.warn(`No web directory at ${WEB_DIR} — API only.`);
}

// ── listeners ────────────────────────────────────────────────────────────────

const banner = () => console.log(`\n${renderBanner({
  port: PORT,
  httpPort: tls ? HTTP_PORT : null,
  tls,
  lanOnly: guard.enabled,
  extraRanges: guard.extra.map(r => r.label),
  pinConfigured: isPinConfigured(),
  pinFromEnv: pinIsFromEnv(),
  dbFile: DB_PATH,
})}\n`);

if (tls) {
  https.createServer({ cert: tls.cert, key: tls.key }, app).listen(PORT, HOST, banner);

  /**
   * A tiny plain-HTTP companion, only when HTTPS is on.
   *
   * It exists to break one chicken-and-egg: a phone cannot trust the
   * certificate until it has the CA, and it cannot fetch the CA over HTTPS
   * because it does not trust the certificate yet. So `/ca` is served in the
   * clear — a public certificate, not a secret — and everything else is
   * redirected to the real thing.
   */
  const helper = express();
  helper.set("trust proxy", false);
  helper.disable("x-powered-by");
  helper.use(lanGuard(guard));

  helper.get("/ca", (_req, res) => {
    if (!hasCa()) {
      res.status(404).type("text/plain").send("No CA copy on this server. Run: npm run setup:https\n");
      return;
    }
    // A .crt extension is what makes iOS offer to install it as a profile.
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", 'attachment; filename="choopi-local-ca.crt"');
    res.send(readFileSync(caPath()));
  });

  helper.get("/ca.txt", (_req, res) => {
    res.type("text/plain").send(hasCa() ? readFileSync(caPath(), "utf8") : "No CA copy.\n");
  });

  helper.use((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] || primaryLanAddress() || "localhost";
    res.redirect(308, `https://${host}:${PORT}${req.originalUrl}`);
  });

  http.createServer(helper).listen(HTTP_PORT, HOST, () => {
    console.log(`[http] CA download + redirect helper on port ${HTTP_PORT}`);
  });
} else {
  http.createServer(app).listen(PORT, HOST, banner);
}

// ── nightly jobs ─────────────────────────────────────────────────────────────

cron.schedule("5 2 * * *", () => {
  runBackup(db)
    .then(r => console.log(
      `[cron] backup ${r.dbFile} + ${r.jsonFile}` +
      `${r.pruned.length ? ` (pruned ${r.pruned.length})` : ""}`
    ))
    .catch(err => console.error("[cron] backup FAILED:", (err as Error).message));
});
cron.schedule("10 2 * * *", () => catchUp("cron"));
