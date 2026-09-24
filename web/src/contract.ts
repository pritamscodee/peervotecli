/**
 * Compiled-contract binding for the browser.
 *
 * Same construction as src/contract.ts minus the `node:fs`-backed
 * `withCompiledFileAssets` step: in the browser the ZK artifacts (proving /
 * verifying keys, zkIR) are served over HTTP by `zkConfigProvider` instead.
 */
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { Contract, ledger } from '../../contracts/managed/private-election/contract/index.js';
import { witnesses, type ElectionPrivateState } from './witnesses';

export const CONTRACT_TAG = 'private-election';

export const compiledContract = CompiledContract.make<
  Contract<ElectionPrivateState>,
  ElectionPrivateState
>(CONTRACT_TAG, Contract<ElectionPrivateState>).pipe(
  CompiledContract.withWitnesses(witnesses),
);

export { ledger as decodeLedger, Contract } from '../../contracts/managed/private-election/contract/index.js';
export type { Ledger, Witnesses } from '../../contracts/managed/private-election/contract/index.js';
export { witnesses, type ElectionPrivateState } from './witnesses';