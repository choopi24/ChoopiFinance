import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "../db/init.js";

const DEV_JWT_SECRET = "choopi-dev-secret-change-in-prod";

/**
 * Resolve the JWT secret. In production a real secret is mandatory:
 * the process refuses to start if JWT_SECRET is unset or still the dev default.
 * Outside production the dev fallback is allowed for convenience.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!secret || secret === DEV_JWT_SECRET) {
      throw new Error(
        "JWT_SECRET must be set to a non-default value in production. " +
          "Refusing to start with an unset or development secret."
      );
    }
    return secret;
  }
  return secret ?? DEV_JWT_SECRET;
}

const JWT_SECRET = resolveJwtSecret();

/** Cookie secure flag — opt in via COOKIE_SECURE=true (e.g. when served over HTTPS). */
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

export interface AuthUser {
  id: number;
  username: string;
  display_currency: string;
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
      .prepare("SELECT id, username, display_currency FROM users WHERE id = ?")
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
