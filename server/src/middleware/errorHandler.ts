import type { ErrorRequestHandler } from "express";

/**
 * Every failure leaves as `{ success: false, error }` — the same envelope
 * `ok()` uses for success — so the client has exactly one response shape to
 * understand.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status: number = (err as { status?: number }).status ?? 500;
  const message: string = err instanceof Error ? err.message : "Something went wrong";

  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ success: false, error: message });
};
