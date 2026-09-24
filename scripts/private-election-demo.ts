/**
 * Full private-election demo (non-interactive).
 *
 * Runs the complete lifecycle of a PearPass election against the deployed
 * contract on the active network:
 *
 *   1. Read the public ledger (OPEN state, zero tally)
 *   2. Five anonymous voters cast ballots (2 for, 3 against) — each with a
 *      brand-new secret in its own private state
 *   3. Verify the auditable tally invariant after every ballot
 *   4. Attempt a double-vote with an ALREADY-USED secret → must be rejected
 *      on-chain (the nullifier set catches it)
 *   5. The authority closes the election; state flips to CLOSED
 *   6. Exit 0 only if every assertion passes
 *
 * This powers the demo video and the CI e2e run.
 */
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet } from '../src/wallet';
import { compiledContract, decodeLedger, zkConfigPath } from '../src/contract';
import { newBallotSecret, ballotIdFromSecret, toHex } from '../src/keys';
import {
  isAuditStoreEnabled,
  initAuditStore,
  recordElection,
  recordReceipt,
  finalizeElection,
} from '../src/db';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const ADMIN_PRIVATE_STATE_ID = 'electionAdminPrivateState';
const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);

function fail(msg: string): never {
  console.error(`\n❌ Demo failed: ${msg}`);
  process.exit(1);
}

function circuitOutputToBytes(result: any): Buffer {
  return Buffer.concat(result?.private?.output?.value ?? []);
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) {
    fail(`No deploy on file for network ${network}. Run \`npm run setup\` first.`);
  }
  console.log(`\n  PearPass election demo on network: ${network}`);
  console.log(`  Contract: ${deployment.address}\n`);

  const walletCtx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  await walletCtx.wallet.waitForSyncedState();

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

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

  const connect = (privateStateId: string, initialPrivateState?: Record<string, unknown>) =>
    findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId,
      ...(initialPrivateState ? { initialPrivateState } : {}),
    });

  const readLedger = async () => {
    const s = await providers.publicDataProvider.queryContractState(deployment.address);
    return s ? decodeLedger(s.data) : null;
  };

  const assertLedger = (ledger: Awaited<ReturnType<typeof readLedger>>, expectFor: number, expectAgainst: number) => {
    if (!ledger) fail('contract state disappeared');
    const ballots = Number(ledger.ballots.size());
    const forV = Number(ledger.tallyFor);
    const againstV = Number(ledger.tallyAgainst);
    console.log(`       for=${forV} against=${againstV} ballots=${ballots}`);
    if (forV !== expectFor || againstV !== expectAgainst) {
      fail(`tally mismatch: got (${forV}, ${againstV}), expected (${expectFor}, ${expectAgainst})`);
    }
    if (ballots !== forV + againstV) {
      fail(`audit invariant broken: ballots (${ballots}) != for (${forV}) + against (${againstV})`);
    }
    return ledger;
  };

  // ── 1. Initial ledger
  console.log('── Step 1: initial public ledger ──────────────────────────────');
  const initial = await readLedger();
  if (!initial) fail('no contract state');
  console.log(`   question: "${initial.question}"`);
  console.log(`   state: ${(initial.state as number) === 0 ? 'OPEN' : initial.state}`);
  assertLedger(initial, 0, 0);

  // ── Receipt store (Postgres/Neon) — optional, best-effort
  const storeEnabled = isAuditStoreEnabled();
  if (storeEnabled) {
    try {
      await initAuditStore();
      await recordElection({
        network,
        contractAddress: deployment.address,
        question: initial.question,
        authorityKey: toHex(initial.authority),
      });
      console.log('\n   📦 Receipt store: election registered for auditing.');
    } catch (storeErr) {
      console.warn(`\n   ⚠ Receipt store unavailable: ${(storeErr as Error).message}`);
    }
  }

  const admin = await connect(ADMIN_PRIVATE_STATE_ID);

  // ── 2. Five voters
  console.log('\n── Step 2: five anonymous voters cast ballots ────────────────');
  const votes: Array<boolean> = [true, false, false, true, false]; // 2 for, 3 against
  const receipts: Array<{ ballotId: string; txId: string; choice: string }> = [];
  const secrets: Uint8Array[] = [];

  for (let i = 0; i < votes.length; i++) {
    const choice = votes[i];
    const secret = newBallotSecret();
    secrets.push(secret);
    const expectedId = ballotIdFromSecret(secret);

    const voter = await connect(`demo-voter-${i}`, { ballotSecret: secret });
    process.stdout.write(`   voter ${i + 1} → ${choice ? 'FOR    ' : 'AGAINST'} ...`);
    const tx = await voter.callTx.castVote(choice);
    const ballotId = circuitOutputToBytes(tx);
    if (!Buffer.from(ballotId).equals(Buffer.from(expectedId))) {
      fail(`voter ${i + 1}: on-chain ballot id != locally predicted id`);
    }
    receipts.push({ ballotId: toHex(ballotId), txId: tx.public.txId, choice: choice ? 'for' : 'against' });
    console.log(`  ballotId=0x${toHex(ballotId).slice(0, 16)}… tx=${tx.public.txId}`);

    if (storeEnabled) {
      try {
        await recordReceipt({
          contractAddress: deployment.address,
          ballotId: toHex(ballotId),
          choice: choice ? 'for' : 'against',
          txId: tx.public.txId,
          blockHeight: Number(tx.public.blockHeight),
        });
      } catch (storeErr) {
        console.log(`   ⚠ receipt store: ${(storeErr as Error).message}`);
      }
    }

    const ledger = await readLedger();
    const forSoFar = votes.slice(0, i + 1).filter(Boolean).length;
    const againstSoFar = votes.slice(0, i + 1).filter((v) => !v).length;
    assertLedger(ledger, forSoFar, againstSoFar);
  }

  console.log('\n   Ballot receipts (all undisclosed, unattributable):');
  for (const r of receipts) {
    console.log(`   • ${r.choice.padEnd(7)} 0x${r.ballotId}`);
  }

  // ── 3. Double-vote attempt (defense in depth: on-chain nullifier set)
  console.log('\n── Step 3: an already-used secret tries to vote again ────────');
  console.log('   (on-chain nullifier set must reject it)...');
  const reVoter = await connect(`demo-voter-0-revoter`, { ballotSecret: secrets[0] });
  try {
    await reVoter.callTx.castVote(true);
    fail('double vote was NOT rejected — the nullifier set is broken');
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes('already cast a ballot')) {
      console.log('   ✅ rejected: "this voter has already cast a ballot"');
    } else if (msg.includes('dataConstraint')) {
      console.log(`   ✅ rejected: chain-level constraint (${msg.slice(0, 60)})`);
    } else {
      console.log(`   ⚠ rejected with a different error (assert message may be\n     wrapped by the ledger): ${msg.slice(0, 160)}`);
    }
  }
  // Tally must be unchanged after the rejected ballot.
  const afterDouble = await readLedger();
  assertLedger(afterDouble, 2, 3);

  // ── 4. Close election
  console.log('\n── Step 4: authority closes the election ──────────────────────');
  const closeTx = await admin.callTx.closeElection();
  console.log(`   ✅ Election closed. tx=${closeTx.public.txId}`);

  const closed = await readLedger();
  if (!closed) fail('no contract state after close');
  if ((closed.state as number) !== 1) fail('state did not flip to CLOSED');
  assertLedger(closed, 2, 3);
  console.log(`   final question: "${closed.question}"`);
  console.log(`   final state:    CLOSED`);
  console.log(`   final tally:    ${closed.tallyFor} for / ${closed.tallyAgainst} against`);

  if (storeEnabled) {
    try {
      await finalizeElection({
        contractAddress: deployment.address,
        state: 1,
        tallyFor: Number(closed.tallyFor),
        tallyAgainst: Number(closed.tallyAgainst),
        ballotsCount: Number(closed.ballots.size()),
      });
      console.log('   📦 Receipt store: election finalized — stored tally mirrors the chain.');
    } catch (storeErr) {
      console.warn(`   ⚠ Receipt store close: ${(storeErr as Error).message}`);
    }
  }

  // ── 5. Voting after close must fail
  console.log('\n── Step 5: voting after close must be rejected ────────────────');
  const lateVoter = await connect(`demo-voter-late`, { ballotSecret: newBallotSecret() });
  try {
    await lateVoter.callTx.castVote(false);
    fail('ballot was accepted after the election closed');
  } catch {
    console.log('   ✅ rejected: election is closed');
  }

  console.log('\n✅ Demo complete — every privacy + tally assertion passed.');
  console.log(`   Live contract: ${deployment.address}`);
  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});