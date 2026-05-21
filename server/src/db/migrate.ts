import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL UNIQUE,
      run_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(r => r.name)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      console.log(`Migration applied: ${file}`);
    } catch (err: unknown) {
      // ALTER TABLE fails if column already exists (fresh installs that include column in schema)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name") || msg.includes("already exists")) {
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
        console.log(`Migration skipped (column already present): ${file}`);
      } else {
        throw err;
      }
    }
  }
}
