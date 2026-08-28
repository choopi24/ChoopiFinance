/**
 * The passcode gate.
 *
 * Three endpoints and nothing else: what state am I in, let me in, let me out.
 * `GET /status` exists so the client can tell "no passcode has been set yet"
 * from "you are signed out" and show the right screen without a failed request.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ok } from "../middleware/respond.js";
import {
  signSession, setAuthCookie, clearAuthCookie, hasValidSession, requireAuth,
} from "../middleware/requireAuth.js";
import { normalizeIp } from "../net/lanGuard.js";
import {
  clearFailures, isPinConfigured, lockState, pinIsFromEnv, recordFailure,
  savePin, verifyPin,
} from "../security/pin.js";
import { HttpError, badRequest } from "./_validate.js";

export const authRouter = Router();

/**
 * A coarse cap on top of the per-device lockout. Generous enough that fat
 * fingers on a phone keypad never trip it, tight enough that a script cannot
 * walk a 6-digit space.
 */
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts — wait a few minutes and try again" },
});

/** Lockouts are keyed per device, so one phone's typos don't lock out the Mac. */
const deviceKey = (req: { socket: { remoteAddress?: string } }) =>
  normalizeIp(req.socket.remoteAddress) || "unknown";

/** GET /api/auth/status — the only endpoint the client may call signed out. */
authRouter.get("/status", (req, res) => {
  const lock = lockState(deviceKey(req));
  ok(res, {
    setup_required: !isPinConfigured(),
    authenticated: hasValidSession(req),
    managed_by_env: pinIsFromEnv(),
    locked: lock.locked,
    retry_in_seconds: lock.retryInSeconds,
  });
});

/**
 * POST /api/auth/setup — set the passcode, allowed only when none exists.
 *
 * Everything on the LAN can reach this server, so this endpoint closes forever
 * the moment a passcode is set. Changing it afterwards requires the current one.
 */
authRouter.post("/setup", unlockLimiter, async (req, res, next) => {
  try {
    if (isPinConfigured()) {
      throw new HttpError("A passcode is already set — unlock with it instead", 409);
    }
    const { pin } = req.body as { pin?: string };
    try {
      await savePin(pin as string);
    } catch (e) {
      throw badRequest((e as Error).message);
    }

    setAuthCookie(res, signSession());
    clearFailures(deviceKey(req));
    ok(res, { ok: true }, 201);
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/unlock */
authRouter.post("/unlock", unlockLimiter, async (req, res, next) => {
  try {
    const key = deviceKey(req);
    const lock = lockState(key);
    if (lock.locked) {
      throw new HttpError(
        `Too many wrong passcodes. Try again in ${Math.ceil(lock.retryInSeconds / 60)} minute(s).`,
        429
      );
    }
    if (!isPinConfigured()) throw badRequest("No passcode has been set yet");

    const { pin } = req.body as { pin?: string };
    if (await verifyPin(String(pin ?? ""))) {
      clearFailures(key);
      setAuthCookie(res, signSession());
      ok(res, { ok: true });
      return;
    }

    const next_state = recordFailure(key);
    throw new HttpError(
      next_state.locked
        ? `Too many wrong passcodes. Locked for ${Math.ceil(next_state.retryInSeconds / 60)} minutes.`
        : `Wrong passcode. ${next_state.remaining} attempt(s) left before a lockout.`,
      401
    );
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/change — current passcode required, even while signed in. */
authRouter.post("/change", requireAuth, async (req, res, next) => {
  try {
    const { current_pin, new_pin } = req.body as { current_pin?: string; new_pin?: string };
    if (pinIsFromEnv()) {
      throw badRequest(
        "The passcode is set by APP_PIN_HASH in server/.env. Change it there with `npm run set-pin`."
      );
    }
    if (!(await verifyPin(String(current_pin ?? "")))) {
      throw new HttpError("Current passcode is incorrect", 403);
    }
    try {
      await savePin(new_pin as string);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    // Re-issue: the new passcode should mean a fresh session, not a stale one.
    setAuthCookie(res, signSession());
    ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/lock", (_req, res) => {
  clearAuthCookie(res);
  ok(res, { ok: true });
});
