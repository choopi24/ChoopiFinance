/**
 * A CRUD router factory. Ten resources share identical mechanics — validate,
 * write inside a transaction, return the stored row — so they share one
 * implementation. Divergent behaviour goes in the `hooks`, not in a copy.
 */

import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { ZodType } from "zod";
import { getDb } from "../db/init.js";
import { ok, fail } from "../middleware/respond.js";

/** Booleans arrive as true/false from JSON but SQLite stores 0/1. */
function normalise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  return out;
}

function zodMessage(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues?.length) return "Invalid request body";
  return issues.map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

export interface ResourceConfig<C, U> {
  table: string;
  createSchema: ZodType<C>;
  updateSchema: ZodType<U>;
  /** Columns allowed in ?filter — keeps query strings from reaching SQL. */
  filterable?: string[];
  orderBy?: string;
  /** Runs inside the same transaction as the write. */
  afterCreate?: (db: Database.Database, id: number) => void;
  afterUpdate?: (db: Database.Database, id: number) => void;
  beforeDelete?: (db: Database.Database, id: number) => void;
}

export function crudRouter<C extends object, U extends object>(
  cfg: ResourceConfig<C, U>
): Router {
  const router = Router();
  const { table } = cfg;
  const orderBy = cfg.orderBy ?? "id";

  const findOne = (db: Database.Database, id: number) =>
    db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

  // LIST
  router.get("/", (req: Request, res: Response) => {
    try {
      const db = getDb();
      const where: string[] = [];
      const params: unknown[] = [];
      for (const col of cfg.filterable ?? []) {
        const v = req.query[col];
        if (v !== undefined) { where.push(`${col} = ?`); params.push(v); }
      }
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 1000)));
      const rows = db.prepare(
        `SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${orderBy} LIMIT ?`
      ).all(...params, limit);
      ok(res, rows);
    } catch (e) { fail(res, (e as Error).message, 500); }
  });

  // READ
  router.get("/:id", (req, res) => {
    try {
      const row = findOne(getDb(), Number(req.params.id));
      if (!row) return fail(res, `${table} row not found`, 404);
      ok(res, row);
    } catch (e) { fail(res, (e as Error).message, 500); }
  });

  // CREATE
  router.post("/", (req, res) => {
    const parsed = cfg.createSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, zodMessage(parsed.error));
    try {
      const db = getDb();
      const data = normalise(parsed.data as Record<string, unknown>);
      const cols = Object.keys(data);
      let id = 0;
      db.transaction(() => {
        id = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")})
           VALUES (${cols.map(() => "?").join(", ")})`
        ).run(...cols.map(c => data[c])).lastInsertRowid as number;
        cfg.afterCreate?.(db, id);
      })();
      ok(res, findOne(db, id), 201);
    } catch (e) { fail(res, (e as Error).message, 400); }
  });

  // UPDATE (partial — only the keys sent are touched)
  router.patch("/:id", (req, res) => {
    const parsed = cfg.updateSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, zodMessage(parsed.error));
    try {
      const db = getDb();
      const id = Number(req.params.id);
      if (!findOne(db, id)) return fail(res, `${table} row not found`, 404);

      const data = normalise(parsed.data as Record<string, unknown>);
      const cols = Object.keys(data);
      if (cols.length === 0) return fail(res, "No fields to update");

      db.transaction(() => {
        db.prepare(
          `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`
        ).run(...cols.map(c => data[c]), id);
        cfg.afterUpdate?.(db, id);
      })();
      ok(res, findOne(db, id));
    } catch (e) { fail(res, (e as Error).message, 400); }
  });

  // DELETE
  router.delete("/:id", (req, res) => {
    try {
      const db = getDb();
      const id = Number(req.params.id);
      if (!findOne(db, id)) return fail(res, `${table} row not found`, 404);
      db.transaction(() => {
        cfg.beforeDelete?.(db, id);
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      })();
      ok(res, { id });
    } catch (e) { fail(res, (e as Error).message, 400); }
  });

  return router;
}

export { zodMessage };
