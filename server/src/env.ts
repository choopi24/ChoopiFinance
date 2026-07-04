/**
 * Loads server/.env into process.env before anything else evaluates.
 * MUST stay the first import in index.ts — requireAuth.ts resolves
 * JWT_SECRET at module scope, so the env has to be populated before the
 * route modules (which import requireAuth) are evaluated.
 *
 * Uses Node's built-in loader (Node 21+) — no dotenv dependency. Values
 * already present in the environment win over the file. A missing .env is
 * fine; the JWT_SECRET check in requireAuth gives the actionable error.
 */

import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
