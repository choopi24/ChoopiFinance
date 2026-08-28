/**
 * npm run backup — take a backup from the command line.
 *
 * Safe to run while the server is up: VACUUM INTO takes a read lock, not an
 * exclusive one. Useful before an upgrade, and as the thing a cron job or a
 * launchd timer calls if you ever want backups independent of the app process.
 */

import { getDb, closeDb } from "../src/db/init.js";
import { BACKUPS_DIR, listBackups, runBackup } from "../src/services/backup.js";
import { fingerprint } from "../src/services/ledgerExport.js";

const run = async () => {
  const db = getDb();
  const before = fingerprint(db);
  const result = await runBackup(db);

  console.log(`\n✓ Backup written to ${BACKUPS_DIR}`);
  console.log(`   ${result.dbFile}    ${Math.round(result.sizeBytes / 1024).toLocaleString()} KB`);
  console.log(`   ${result.jsonFile}  full ledger as JSON`);
  console.log(`   integrity check: ${result.integrityOk ? "ok" : "FAILED"}  (${result.durationMs}ms)`);

  if (result.pruned.length) {
    console.log(`\n   pruned ${result.pruned.length} file(s) past the retention window`);
  }
  console.log(`\n   ${listBackups().length} backup(s) on disk`);
  console.log(`   ${before.transactions} transactions, ${before.accounts} accounts captured\n`);

  closeDb();
};

run().catch(err => {
  console.error(`\n✗ Backup failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
