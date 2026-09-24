/**
 * Independent audit of a PearPass election: reconcile the EXTERNAL receipt
 * store (Postgres/Neon) against the ON-CHAIN ledger.
 *
 *   • stored receipts  (per-vote for/against, from voters' local receipts)
 *   • on-chain tally   (tallyFor + tallyAgainst counters, ballots.size())
 *
 * Exits 1 if the two disagree. Read-only on the chain; requires DATABASE_URL.
 */
import { WebSocket } from 'ws';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import { compiledContract, decodeLedger, zkConfigPath } from '../src/contract';
import {
  initAuditStore,
  isAuditStoreEnabled,
  getStoredElection,
  getStoredReceiptCounts,
  recordElection,
} from '../src/db';
import { toHex } from '../src/keys';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

function fail(msg: string): never {
  console.error(`❌ audit failed: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!isAuditStoreEnabled()) {
    console.error('❌ DATABASE_URL is not set. Add it to .env (gitignored).');
    process.exit(1);
  }

  const deployment = getDeployment(resolveNetwork().network);
  if (!deployment) fail('no deploy on file — run `npm run deploy` first.');

  const { network, config: networkConfig } = resolveNetwork();
  const WALLET = getOrCreateWallet(network);
  const walletCtx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  await walletCtx.wallet.waitForSyncedState();

  try {
    console.log(`\n  Auditing PearPass election: ${deployment.address}`);
    console.log(`  network: ${network}\n`);

    await initAuditStore();

    // 1. On-chain ledger (source of truth for the aggregate tally).
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'private-election-state',
        accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
        privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
      zkConfigProvider: new NodeZkConfigProvider(zkConfigPath),
      proofProvider: httpClientProofProvider(networkConfig.proofServer, new NodeZkConfigProvider(zkConfigPath)),
    } as any;

    const onChainState = await providers.publicDataProvider.queryContractState(deployment.address);
    if (!onChainState) fail(`queryContractState returned null for ${deployment.address}`);
    const ledger = decodeLedger(onChainState.data);
    const chainFor = Number(ledger.tallyFor);
    const chainAgainst = Number(ledger.tallyAgainst);
    const chainBallots = Number(ledger.ballots.size());

    // 2. External store (upsert election metadata so FK constraints hold).
    await recordElection({
      network,
      contractAddress: deployment.address,
      question: ledger.question,
      authorityKey: toHex(ledger.authority),
    });

    const stored = await getStoredElection(deployment.address);
    const storedCounts = await getStoredReceiptCounts(deployment.address);
    const storedFor = storedCounts.for;
    const storedAgainst = storedCounts.against;
    const storedBallots = stored ? Number(stored.ballots_count) : 0;

    console.log('  ── on-chain ledger ────────────────────────────');
    console.log(`  for=${chainFor}  against=${chainAgainst}  ballots=${chainBallots}`);
    console.log('  ── receipt store ──────────────────────────────');
    console.log(`  for=${storedFor}  against=${storedAgainst}  stored_ballots=${storedBallots}\n`);

    const checks: Array<[string, boolean]> = [
      ['receipts.for == on-chain tallyFor', storedFor === chainFor],
      ['receipts.against == on-chain tallyAgainst', storedAgainst === chainAgainst],
      ['receipts total == on-chain ballots.size()', storedFor + storedAgainst === chainBallots],
      ['election tally recorded == on-chain tally', storedBallots === chainBallots],
    ];

    for (const [label, ok] of checks) {
      console.log(`  ${ok ? '✅' : '❌'} ${label}`);
      if (!ok) fail(label);
    }

    console.log('\n  ✅ Audit reconciled: external receipts match the chain.');
  } finally {
    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});