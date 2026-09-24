/**
 * Compiled-contract binding for the private-election contract.
 *
 * Mirrors the example-bboard pattern: a static import of the compiler output
 * wrapped in a CompiledContract with real witness implementations attached.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { Contract, ledger } from '../contracts/managed/private-election/contract/index.js';
import { witnesses, type ElectionPrivateState } from './witnesses';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'private-election');
export const CONTRACT_TAG = 'private-election';

// Contract library handle. Marker comment: `npm run compile` regenerates the
// managed output; this binding fails loudly if it is missing.
if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

export const compiledContract = CompiledContract.make<
  Contract<ElectionPrivateState>,
  ElectionPrivateState
>(CONTRACT_TAG, Contract<ElectionPrivateState>).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

export { ledger as decodeLedger, Contract } from '../contracts/managed/private-election/contract/index.js';
export type { Ledger, Witnesses } from '../contracts/managed/private-election/contract/index.js';
export { witnesses, type ElectionPrivateState } from './witnesses';