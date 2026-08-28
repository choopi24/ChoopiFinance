/**
 * The app passcode.
 *
 * One PIN guards the whole app. It exists because "only devices on my wifi can
 * reach it" is not the same as "only I can reach it" — a housemate, a guest, a
 * smart TV or anything else on the network would otherwise browse straight in.
 *
 * Only the bcrypt hash is ever stored, and never in the repo: either in
 * APP_PIN_HASH (server/.env, gitignored) or in server/config/pin.json
 * (gitignored). The env wins when both are present, so a service manager can
 * inject it without a file on disk.
 *
 * A short numeric PIN is guessable by machine, so brute-force resistance comes
 * from the lockout below rather than from entropy: bcrypt makes each guess slow,
 * the rate limiter caps attempts per window, and repeated failures lock the door
 * for a while regardless.
 */

import bcrypt from "bcrypt";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG_DIR = join(__dirname, "../../config");
export const PIN_FILE = join(CONFIG_DIR, "pin.json");

const BCRYPT_ROUNDS = 12;
const MIN_DIGITS = 4;
const MAX_DIGITS = 12;

interface PinFile {
  pin_hash: string;
  updated_at: string;
}

/** The stored hash, env first. Null when no PIN has been set yet. */
export function pinHash(): string | null {
  const fromEnv = process.env.APP_PIN_HASH?.trim();
  if (fromEnv) return fromEnv;

  if (!existsSync(PIN_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PIN_FILE, "utf8")) as PinFile;
    return parsed.pin_hash?.trim() || null;
  } catch {
    // A corrupt file must not silently mean "no PIN required".
    throw new Error(
      `${PIN_FILE} exists but could not be read as JSON. Fix or delete it — ` +
      `refusing to start with an unreadable passcode file.`
    );
  }
}

export const isPinConfigured = (): boolean => pinHash() !== null;

/**
 * A short, stable fingerprint of the CURRENT passcode hash.
 *
 * Sessions carry it, so changing the passcode invalidates every session that
 * was issued under the old one — on every device, immediately. Without this,
 * "change the passcode" only stops future logins, and a phone that was already
 * signed in keeps full access until its cookie expires, which is precisely the
 * situation you change a passcode to end.
 *
 * It is a hash OF a bcrypt hash, so the token leaks nothing useful even if read.
 */
export function pinFingerprint(): string {
  const hash = pinHash();
  if (!hash) return "unset";
  return createHash("sha256").update(hash).digest("hex").slice(0, 16);
}

/** True when the PIN comes from the environment and so cannot be changed in-app. */
export const pinIsFromEnv = (): boolean => Boolean(process.env.APP_PIN_HASH?.trim());

export function assertValidPin(pin: unknown): string {
  if (typeof pin !== "string" || !/^\d+$/.test(pin)) {
    throw new Error("The passcode must be digits only");
  }
  if (pin.length < MIN_DIGITS || pin.length > MAX_DIGITS) {
    throw new Error(`The passcode must be ${MIN_DIGITS}–${MAX_DIGITS} digits`);
  }
  return pin;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(assertValidPin(pin), BCRYPT_ROUNDS);
}

/** Write a new PIN to the config file. Refuses when the env owns it. */
export async function savePin(pin: string): Promise<string> {
  if (pinIsFromEnv()) {
    throw new Error(
      "APP_PIN_HASH is set in the environment, so the passcode is managed there. " +
      "Change it in server/.env (npm run set-pin prints a fresh hash), or remove " +
      "APP_PIN_HASH to manage the passcode from the app."
    );
  }
  const hash = await hashPin(pin);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    PIN_FILE,
    `${JSON.stringify({ pin_hash: hash, updated_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  try { chmodSync(PIN_FILE, 0o600); } catch { /* best effort on odd filesystems */ }
  return hash;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = pinHash();
  if (!hash) return false;
  if (typeof pin !== "string" || !pin) return false;
  try {
    return await bcrypt.compare(pin, hash);
  } catch {
    return false;
  }
}

// ── lockout ──────────────────────────────────────────────────────────────────

/**
 * Per-device failure tracking, in memory.
 *
 * In memory on purpose: a restart clearing the counter is acceptable (you
 * control the machine), and it keeps failed guesses out of the database and
 * out of the backups.
 */
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Attempts { failures: number; lockedUntil: number }
const attempts = new Map<string, Attempts>();

export interface LockState { locked: boolean; retryInSeconds: number; remaining: number }

export function lockState(key: string, now = Date.now()): LockState {
  const entry = attempts.get(key);
  if (!entry) return { locked: false, retryInSeconds: 0, remaining: MAX_FAILURES };
  if (entry.lockedUntil > now) {
    return {
      locked: true,
      retryInSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }
  return { locked: false, retryInSeconds: 0, remaining: Math.max(0, MAX_FAILURES - entry.failures) };
}

export function recordFailure(key: string, now = Date.now()): LockState {
  const entry = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = 0; // the lockout replaces the count; it restarts after it expires
  }
  attempts.set(key, entry);
  return lockState(key, now);
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Test seam. */
export function resetLockouts(): void {
  attempts.clear();
}
