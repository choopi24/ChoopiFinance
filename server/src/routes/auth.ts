import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcrypt";
import { getDb } from "../db/init.js";
import { signToken, setAuthCookie, clearAuthCookie, requireAuth } from "../middleware/requireAuth.js";

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

// Throttle credential endpoints: 10 attempts / 15 min / IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

// POST /api/auth/register
authRouter.post("/register", authLimiter, async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || typeof username !== "string" || username.trim().length < 2) {
    res.status(400).json({ error: "Username must be at least 2 characters" });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim());
  if (existing) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(username.trim(), password_hash);

  const userId = result.lastInsertRowid as number;
  const token = signToken(userId);
  setAuthCookie(res, token);

  const user = db
    .prepare("SELECT id, username, display_currency FROM users WHERE id = ?")
    .get(userId);

  res.status(201).json({ user });
});

// POST /api/auth/login
authRouter.post("/login", authLimiter, async (req, res) => {
  const { username, password, stay_signed_in = false } = req.body as {
    username?: string; password?: string; stay_signed_in?: boolean;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  const db = getDb();
  const row = db
    .prepare("SELECT id, username, password_hash, display_currency, stay_signed_in FROM users WHERE username = ?")
    .get(username.trim()) as { id: number; username: string; password_hash: string; display_currency: string; stay_signed_in: number } | undefined;

  if (!row) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const matched = await bcrypt.compare(password, row.password_hash);
  if (!matched) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Use the incoming flag OR the stored preference, whichever is true
  const extendedSession = stay_signed_in || Boolean(row.stay_signed_in);

  db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(row.id);

  const token = signToken(row.id, extendedSession);
  setAuthCookie(res, token, extendedSession);

  res.json({
    user: { id: row.id, username: row.username, display_currency: row.display_currency },
  });
});

// POST /api/auth/logout
authRouter.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
