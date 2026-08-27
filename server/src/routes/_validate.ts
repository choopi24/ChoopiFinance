/**
 * Request-parsing helpers shared by every route module.
 *
 * They all throw `HttpError`, which `errorHandler` turns into a JSON response
 * with the right status — so route bodies read as a list of assertions
 * followed by the actual work, with no error plumbing in between.
 */

import type { Request } from "express";
import { isIsoDate, today, type IsoDate } from "../calc/index.js";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(msg, 400);
export const notFound = (what: string) => new HttpError(`${what} not found`, 404);

type Body = Record<string, unknown>;

/** True when the key was omitted entirely — the signal for a PATCH no-op. */
export const absent = (body: Body, key: string): boolean =>
  !Object.prototype.hasOwnProperty.call(body, key);

export function str(body: Body, key: string, opts: { max?: number } = {}): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw badRequest(`${key} is required`);
  const s = v.trim();
  if (opts.max && s.length > opts.max) throw badRequest(`${key} is too long (max ${opts.max})`);
  return s;
}

export function optStr(body: Body, key: string, opts: { max?: number } = {}): string | null {
  const v = body[key];
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`${key} must be text`);
  const s = v.trim();
  if (!s) return null;
  if (opts.max && s.length > opts.max) throw badRequest(`${key} is too long (max ${opts.max})`);
  return s;
}

export function enumOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const v = body[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw badRequest(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export function optEnumOf<T extends string>(
  body: Body, key: string, allowed: readonly T[]
): T | null {
  if (body[key] == null || body[key] === "") return null;
  return enumOf(body, key, allowed);
}

/**
 * Money. Integer minor units only — the API never accepts a decimal amount,
 * so no rounding decision is ever made server-side on data the client typed.
 */
export function minorInt(body: Body, key: string, opts: { min?: number; max?: number } = {}): number {
  const v = body[key];
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw badRequest(`${key} must be a number`);
  if (!Number.isInteger(n)) throw badRequest(`${key} must be a whole number of minor units (agorot/cents)`);
  if (opts.min != null && n < opts.min) throw badRequest(`${key} must be at least ${opts.min}`);
  if (opts.max != null && n > opts.max) throw badRequest(`${key} must be at most ${opts.max}`);
  return n;
}

export function optMinorInt(body: Body, key: string, opts: { min?: number; max?: number } = {}): number | null {
  if (body[key] == null || body[key] === "") return null;
  return minorInt(body, key, opts);
}

/** A genuinely fractional quantity (0.0123 BTC) or a percentage. */
export function num(body: Body, key: string, opts: { min?: number; max?: number } = {}): number {
  const v = body[key];
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw badRequest(`${key} must be a number`);
  if (opts.min != null && n < opts.min) throw badRequest(`${key} must be at least ${opts.min}`);
  if (opts.max != null && n > opts.max) throw badRequest(`${key} must be at most ${opts.max}`);
  return n;
}

export function optNum(body: Body, key: string, opts: { min?: number; max?: number } = {}): number | null {
  if (body[key] == null || body[key] === "") return null;
  return num(body, key, opts);
}

export function bool(body: Body, key: string, fallback: boolean): boolean {
  const v = body[key];
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  throw badRequest(`${key} must be true or false`);
}

export function date(body: Body, key: string): IsoDate {
  const v = body[key];
  if (!isIsoDate(v)) throw badRequest(`${key} must be a date as YYYY-MM-DD`);
  return v;
}

export function optDate(body: Body, key: string): IsoDate | null {
  if (body[key] == null || body[key] === "") return null;
  return date(body, key);
}

export function intParam(raw: unknown, what = "id"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${what}`);
  return n;
}

// ── query-string helpers ─────────────────────────────────────────────────────

export function qDate(req: Request, key: string, fallback: IsoDate = today()): IsoDate {
  const v = req.query[key];
  if (v == null || v === "") return fallback;
  if (!isIsoDate(v)) throw badRequest(`${key} must be a date as YYYY-MM-DD`);
  return v;
}

export function qInt(req: Request, key: string, fallback: number, max = 1000): number {
  const v = req.query[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${key} must be a non-negative whole number`);
  return Math.min(n, max);
}

export function qEnum<T extends string>(req: Request, key: string, allowed: readonly T[], fallback: T): T {
  const v = req.query[key];
  if (v == null || v === "") return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw badRequest(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export const CURRENCIES = ["ILS", "USD"] as const;
export const CATEGORIES = [
  "stock", "etf", "crypto", "keren_hishtalmut", "pension", "gemel_lehashkaa", "rsu", "cash",
] as const;
export const VALUATION_MODES = ["market", "balance"] as const;
export const FUNDING_MODES = ["manual", "salary", "passive"] as const;
export const ASSET_CLASSES = ["stock", "etf", "crypto"] as const;
export const TX_TYPES = [
  "deposit", "withdrawal", "buy", "sell", "fee", "dividend", "adjustment",
] as const;
export const FEE_KINDS = ["management_balance", "management_deposit", "trade", "other"] as const;
export const CONTRIBUTION_PARTS = ["employee", "employer", "severance"] as const;
export const FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
export const VEST_STATUSES = ["scheduled", "vested", "cancelled"] as const;
