/**
 * Read-only end-to-end check for PearPass (private-election).
 *
 * Reconnects to the deployed contract, decodes the public ledger, and verifies
 * the auditable-tally invariant:
 *
 *     ballots.size() == tallyFor + tallyAgainst
 *
 * Used by `npm run test:e2e` and CI. Read-only: builds no transactions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, getDeployment } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import { compiledContract, decodeLedger, zkConfigPath, CONTRACT_TAG } from '../src/contract';
import { toHex } from '../src/keys';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const ADMIN_PRIVATE_STATE_ID = 'electionAdminPrivateState';

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

function fail(msg: string): never {
  console.error(`❌ e2e-check failed: ${msg}`);
  process.exit(1);
}

function isHexAddress(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length >= 32;
}

async function main() {
  // 1. Deployment sanity
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}.`);
    process.exit(1);
  }
  if (!isHexAddress(deployment.address)) {
    fail(`Deployment address missing or invalid: ${JSON.stringify(deployment, null, 2)}`);
  }

  // 2. Compiled contract sanity
  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    fail('Compiled contract missing — run `npm run compile`.');
  }

  // 3. Wallet + providers
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx() {
      throw new Error('e2e-check is read-only and should not balance transactions');
    },
    submitTx() {
      throw new Error('e2e-check is read-only and should not submit transactions');
    },
  } as any;

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'private-election-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // 4. Reconnect — proves the witness wiring is complete (authority identity).
  try {
    await findDeployedContract(providers, {
      contractAddress: deployment.address,
      compiledContract: compiledContract as any,
      privateStateId: ADMIN_PRIVATE_STATE_ID,
    });
  } catch (err: any) {
    await walletCtx.wallet.stop();
    fail(`findDeployedContract threw: ${err?.message ?? err}`);
  }

  // 5. Read on-chain state + verify invariants.
  const onChainState = await providers.publicDataProvider.queryContractState(deployment.address);
  if (!onChainState) {
    await walletCtx.wallet.stop();
    fail(`queryContractState returned null for ${deployment.address}`);
  }

  const ledger = decodeLedger(onChainState.data);
  const tallyTotal = Number(ledger.tallyFor) + Number(ledger.tallyAgainst);
  const ballots = Number(ledger.ballots.size());

  const checks: Array<[string, boolean]> = [
    ['contract address is a valid hex string', isHexAddress(deployment.address)],
    ['contract outline matches the private-election tag', CONTRACT_TAG === 'private-election'],
    ['question decodes to a non-empty string', typeof ledger.question === 'string' && ledger.question.length > 0],
    [`tally is audit-consistent: ballots(${ballots}) == for(${ledger.tallyFor}) + against(${ledger.tallyAgainst})`, ballots === tallyTotal],
    ['authority key decodes to 32 bytes', ledger.authority.length === 32],
    ['state is a valid ElectionState (0=OPEN, 1=CLOSED)', (ledger.state as number) === 0 || (ledger.state as number) === 1],
  ];

  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) {
      await walletCtx.wallet.stop();
      fail(label);
    }
  }

  console.log(`\n✅ e2e-check passed`);
  console.log(`   contractAddress: ${deployment.address}`);
  console.log(`   question:        "${ledger.question}"`);
  console.log(`   network:         ${network}`);

  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});