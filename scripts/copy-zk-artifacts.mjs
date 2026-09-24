// Copy the compiled circuit artifacts (proving/verifying keys + zkIR) into web/public so a static
// host (Vercel) can serve them at /zkconfig/private-election/... — the path FetchZkConfigProvider
// requests. Without this the hosted dashboard depends on the local API (port 3001) for proofs.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "contracts", "managed", "private-election");
const dest = path.join(root, "web", "public", "zkconfig", "private-election");

if (!existsSync(path.join(src, "keys"))) {
  console.error("❌ contracts/managed/private-election/keys not found — run `npm run compile` first.");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
for (const kind of ["keys", "zkir"]) {
  mkdirSync(path.join(dest, kind), { recursive: true });
  cpSync(path.join(src, kind), path.join(dest, kind), { recursive: true });
}
console.log(`✓ ZK artifacts copied to ${path.relative(root, dest)}`);
