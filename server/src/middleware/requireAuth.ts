import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "../db/init.js";

// The old baked-in fallback — kept only to reject configs still using it.
const LEGACY_DEV_SECRET = "choopi-dev-secret-change-in-prod";

/**
 * Resolve the JWT secret. A real secret is mandatory in EVERY mode — the
 * process fails fast at startup if JWT_SECRET is unset, blank, or still the
 * old baked-in dev default. server/.env is loaded by src/env.ts (imported
 * first in index.ts); see .env.example.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim() || secret === LEGACY_DEV_SECRET) {
    throw new Error(
      "JWT_SECRET is not configured. Create server/.env with a real secret " +
        '(e.g. JWT_SECRET=$(openssl rand -hex 32)) — see server/.env.example. ' +
        "Refusing to start with a missing or default secret."
    );
  }
  return secret;
}

const JWT_SECRET = resolveJwtSecret();

/** Cookie secure flag — opt in via COOKIE_SECURE=true (e.g. when served over HTTPS). */
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

export interface AuthUser {
  id: number;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.cf_token as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    const db = getDb();
    const user = db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(payload.sub) as AuthUser | undefined;

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function signToken(userId: number, staySignedIn = false): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: staySignedIn ? "90d" : "30d" });
}

export function setAuthCookie(res: Response, token: string, staySignedIn = false): void {
  res.cookie("cf_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE, // env-driven: COOKIE_SECURE=true when served over HTTPS
    maxAge: (staySignedIn ? 90 : 30) * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie("cf_token", { path: "/" });
}
