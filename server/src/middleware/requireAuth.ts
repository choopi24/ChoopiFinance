/**
 * Session handling for the app passcode.
 *
 * The cookie is a signed JWT carrying nothing but a scope and an expiry — there
 * is no user table behind it, because there is one PIN and one person. It is
 * httpOnly and SameSite=Lax, so a page on another origin cannot read it or ride
 * on it.
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pinFingerprint } from "../security/pin.js";

// The old baked-in fallback — kept only to reject configs still using it.
const LEGACY_DEV_SECRET = "choopi-dev-secret-change-in-prod";

export const SESSION_COOKIE = "cf_session";
const SESSION_SCOPE = "app";

/**
 * Resolve the signing secret. A real secret is mandatory in EVERY mode — the
 * process fails fast at startup if JWT_SECRET is unset, blank, or still the old
 * baked-in dev default. server/.env is loaded by src/env.ts (imported first in
 * index.ts); see .env.example.
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

/**
 * Whether the session cookie is marked Secure.
 *
 * Defaults to whatever the server is actually serving: HTTPS sets it, plain
 * HTTP does not — because a Secure cookie over http:// is simply never sent,
 * which looks exactly like a broken login. index.ts calls setCookieSecure()
 * once it knows which listener it started. COOKIE_SECURE overrides both ways.
 */
let cookieSecure = process.env.COOKIE_SECURE === "true";

export function setCookieSecure(value: boolean): void {
  const override = process.env.COOKIE_SECURE;
  cookieSecure = override === undefined || override === "" ? value : override === "true";
}

export const isCookieSecure = (): boolean => cookieSecure;

/** How long a signed-in phone stays signed in. */
const SESSION_DAYS = 30;

export function signSession(days = SESSION_DAYS): string {
  // `pv` pins the session to the passcode it was issued under — see
  // security/pin.pinFingerprint.
  return jwt.sign(
    { scope: SESSION_SCOPE, pv: pinFingerprint() },
    JWT_SECRET,
    { expiresIn: `${days}d` }
  );
}

export function setAuthCookie(res: Response, token: string, days = SESSION_DAYS): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    maxAge: days * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** True when the request carries a valid, unexpired session. */
export function hasValidSession(req: Request): boolean {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { scope?: string; pv?: string };
    if (payload.scope !== SESSION_SCOPE) return false;
    // Issued under a passcode that has since been changed → no longer valid.
    return payload.pv === pinFingerprint();
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (hasValidSession(req)) {
    next();
    return;
  }
  // 401 rather than 403: the client's job is to show the passcode screen.
  res.status(401).json({ success: false, error: "Not signed in" });
}
