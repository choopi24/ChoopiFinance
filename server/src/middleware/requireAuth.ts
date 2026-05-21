import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "../db/init.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "choopi-dev-secret-change-in-prod";

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
    secure: false, // LAN context — no HTTPS
    maxAge: (staySignedIn ? 90 : 30) * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie("cf_token", { path: "/" });
}
