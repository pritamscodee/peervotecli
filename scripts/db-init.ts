/**
 * Initialize the PearPass receipt/audit store schema (idempotent).
 *
 * Requires DATABASE_URL (set it in .env — gitignored). Run once per database.
 */
import { initAuditStore, isAuditStoreEnabled, getDatabaseUrl } from '../src/db';

async function main() {
  if (!isAuditStoreEnabled()) {
    console.error('❌ DATABASE_URL is not set. Add it to .env (the file is gitignored).');
    process.exit(1);
  }
  const url = new URL(getDatabaseUrl()!);
  console.log(`\n  Initializing PearPass audit store on ${url.host}`);
  await initAuditStore();
  console.log('  ✅ Schema ready: elections, ballot_receipts.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});