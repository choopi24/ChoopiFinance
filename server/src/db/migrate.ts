import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** `migrationsDir` is overridable for tests only; production always uses the default. */
export function runMigrations(db: Database.Database, migrationsDir: string = MIGRATIONS_DIR): void {
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

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      console.log(`Migration applied: ${file}`);
    } catch (err: unknown) {
      // A failure inside an explicit BEGIN (the table-rebuild migrations)
      // leaves the transaction open on this connection — roll it back so the
      // DB isn't left mid-rebuild and later statements don't join it.
      if (db.inTransaction) db.exec("ROLLBACK");
      db.pragma("foreign_keys = ON"); // rebuilds toggle it off before BEGIN

      // ONLY "duplicate column name" means already-applied (fresh installs
      // whose schema.sql already contains the column an ALTER adds).
      // "table ... already exists" must SURFACE: it signals a half-done
      // rebuild, and marking it applied would hide real breakage.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name")) {
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
        console.log(`Migration skipped (column already present): ${file}`);
      } else {
        throw err;
      }
    }
  }
}
