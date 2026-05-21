import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runMigrations } from "./migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../data/choopi.db");
const SCHEMA_PATH = join(__dirname, "schema.sql");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("foreign_keys = ON");
  _db.pragma("journal_mode = WAL");

  // Run schema (all statements are CREATE TABLE IF NOT EXISTS — idempotent)
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  _db.exec(schema);

  // Apply incremental migrations
  runMigrations(_db);

  console.log(`SQLite ready  →  ${DB_PATH}`);
  return _db;
}
