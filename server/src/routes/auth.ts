/**
 * Login. Deliberately thin: one user, one cookie.
 *
 * `GET /status` exists so the client can tell "nobody has registered yet" from
 * "you are signed out" and show the right screen without a failed request.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcrypt";
import { getDb } from "../db/init.js";
import { ok } from "../middleware/respond.js";
import {
  signToken, setAuthCookie, clearAuthCookie, requireAuth,
} from "../middleware/requireAuth.js";
import { HttpError, badRequest } from "./_validate.js";

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

const userCount = (): number =>
  (getDb().prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;

/** GET /api/auth/status — no auth required. */
authRouter.get("/status", (req, res) => {
  ok(res, { setup_required: userCount() === 0, authenticated: Boolean(req.cookies?.cf_token) });
});

/**
 * POST /api/auth/register — allowed only while no user exists.
 *
 * This app is reachable by everything on the LAN, so leaving registration open
 * would mean any device on the network could create itself an account.
 */
authRouter.post("/register", authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (userCount() > 0) {
      throw new HttpError("This tracker already has an account — sign in instead", 409);
    }
    if (!username || typeof username !== "string" || username.trim().length < 2) {
      throw badRequest("Username must be at least 2 characters");
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      throw badRequest("Password must be at least 8 characters");
    }

    const db = getDb();
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(username.trim(), hash);

    const id = r.lastInsertRowid as number;
    setAuthCookie(res, signToken(id, true), true);
    ok(res, { user: { id, username: username.trim() } }, 201);
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/login */
authRouter.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { username, password, stay_signed_in = true } = req.body as {
      username?: string; password?: string; stay_signed_in?: boolean;
    };
    if (!username || !password) throw badRequest("Username and password required");

    const db = getDb();
    const row = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get(String(username).trim()) as
      { id: number; username: string; password_hash: string } | undefined;

    // Same message either way — a different one for an unknown username would
    // tell anyone on the LAN which names exist.
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError("Invalid credentials", 401);
    }

    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
      .run(row.id);

    setAuthCookie(res, signToken(row.id, stay_signed_in), stay_signed_in);
    ok(res, { user: { id: row.id, username: row.username } });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  ok(res, { ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  ok(res, { user: req.user });
});
