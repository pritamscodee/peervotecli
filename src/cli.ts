/**
 * Interactive CLI for the private-election DApp.
 *
 * Two roles live in this terminal:
 *   • The election authority (deployer): closes the election, reads state.
 *   • Anonymous voters: each "cast a ballot" creates a brand-new voter
 *     identity (a fresh ballot secret in its own private state) — mirroring
 *     how voters use Lace in the web UI.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, getDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { compiledContract, decodeLedger, zkConfigPath } from './contract';
import { newBallotSecret, ballotIdFromSecret, toHex } from './keys';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const ADMIN_PRIVATE_STATE_ID = 'electionAdminPrivateState';

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

// ─── Providers ─────────────────────────────────────────────────────────────────

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

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

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'private-election-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// A "found contract" handle scoped to a private-state id.
async function connect(
  providers: Awaited<ReturnType<typeof createProviders>>,
  contractAddress: string,
  options: { privateStateId: string; initialPrivateState?: Record<string, unknown> },
): Promise<any> {
  return findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress,
    privateStateId: options.privateStateId,
    ...(options.initialPrivateState ? { initialPrivateState: options.initialPrivateState } : {}),
  });
}

function circuitOutputToBytes(result: any): Buffer {
  const value: Array<Uint8Array> = result?.private?.output?.value ?? [];
  return Buffer.concat(value);
}

// Public RPC/indexer endpoints drop idle websockets ("1000:: Normal Closure"); a submit that lands on
// a dead socket fails even though the proof and the tx are fine. Retrying is safe: re-casting with the
// same ballot secret discloses the same nullifier, so the contract rejects any double count.
const TRANSIENT_ERROR = /disconnected from|Normal Closure|SubmissionError|submission failed|ECONNRESET|socket hang up|Not enough Dust|could not balance dust/i;
const SUBMIT_ATTEMPTS = 4;

async function withSubmitRetry(label: string, fn: () => Promise<any>): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const text = `${error instanceof Error ? error.message : error} ${(error as any)?.cause?.cause?.message ?? ''} ${(error as any)?.cause?.message ?? ''}`;
      if (attempt >= SUBMIT_ATTEMPTS || !TRANSIENT_ERROR.test(text)) throw error;
      const delaySec = 10 * attempt;
      console.log(`  ⚠ ${label}: network hiccup (attempt ${attempt}/${SUBMIT_ATTEMPTS}) — retrying in ${delaySec}s...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
}

// Any HTTP answer means the proof server is up; only connection-level failures mean it's down.
async function isProofServerUp(): Promise<boolean> {
  try {
    await fetch(networkConfig.proofServer, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function requireProofServer(): Promise<boolean> {
  if (await isProofServerUp()) return true;
  console.error(`\n  ❌ Proof server not reachable at ${networkConfig.proofServer}.`);
  console.log('     Start it with: npm run proof-server:start\n');
  return false;
}

// Translate the SDK's raw failure text into something a voter can act on.
function explainFailure(error: unknown): string | null {
  const text = `${error instanceof Error ? error.message : error} ${(error as any)?.cause?.message ?? ''}`;
  if (/Not enough Dust|could not balance dust|Insufficient Funds/i.test(text)) {
    return 'The wallet ran out of DUST for fees. DUST regenerates from tNIGHT — check option 5, wait a minute, retry.';
  }
  if (/election is closed/i.test(text)) return 'The election was closed before this ballot landed.';
  if (/Failed to connect to Proof Server|ECONNREFUSED 127\.0\.0\.1:6300/i.test(text)) {
    return 'The proof server stopped responding. Restart it with: npm run proof-server:start';
  }
  if (/disconnected from|Normal Closure|SubmissionError/i.test(text)) {
    return 'The network kept dropping the connection. Wait a minute and try again.';
  }
  return null;
}

async function readLedger(providers: Awaited<ReturnType<typeof createProviders>>, address: string) {
  const contractState = await providers.publicDataProvider.queryContractState(address);
  return contractState ? decodeLedger(contractState.data) : null;
}

function describeLedger(ledger: Awaited<ReturnType<typeof readLedger>>) {
  if (!ledger) return '  ⚠ No contract state found.';
  const open = ledger.state === 0 ? 'OPEN' : ledger.state === 1 ? 'CLOSED' : String(ledger.state);
  const ballots = Number(ledger.ballots.size());
  return [
    `  Question:       "${ledger.question}"`,
    `  State:          ${open}`,
    `  For:            ${Number(ledger.tallyFor)}`,
    `  Against:        ${Number(ledger.tallyAgainst)}`,
    `  Total ballots:  ${ballots}`,
    `  Authority key:  0x${toHex(ledger.authority)}`,
    '',
    `  Audit check:    ballots (${ballots}) == tallyFor (${ledger.tallyFor}) + tallyAgainst (${ledger.tallyAgainst})?`,
    `                  ${ballots === Number(ledger.tallyFor) + Number(ledger.tallyAgainst) ? '✅ yes — tally is verifiable' : '❌ no — somebody is cheating!'}`,
  ].join('\n');
}

// ─── Main CLI ──────────────────────────────────────────────────────────────────

// "PEERVOTE CLI" in figlet's ANSI Shadow font, pre-rendered so we don't pull in figlet at runtime.
const BANNER = [
  '██████╗ ███████╗███████╗██████╗ ██╗   ██╗ ██████╗ ████████╗███████╗',
  '██╔══██╗██╔════╝██╔════╝██╔══██╗██║   ██║██╔═══██╗╚══██╔══╝██╔════╝',
  '██████╔╝█████╗  █████╗  ██████╔╝██║   ██║██║   ██║   ██║   █████╗  ',
  '██╔═══╝ ██╔══╝  ██╔══╝  ██╔══██╗╚██╗ ██╔╝██║   ██║   ██║   ██╔══╝  ',
  '██║     ███████╗███████╗██║  ██║ ╚████╔╝ ╚██████╔╝   ██║   ███████╗',
  '╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝   ╚═════╝    ╚═╝   ╚══════╝',
  '',
  '                      ██████╗██╗     ██╗',
  '                     ██╔════╝██║     ██║',
  '                     ██║     ██║     ██║',
  '                     ██║     ██║     ██║',
  '                     ╚██████╗███████╗██║',
  '                      ╚═════╝╚══════╝╚═╝',
];

function printBanner(): void {
  const color = stdout.isTTY && !process.env.NO_COLOR;
  const paint = (s: string) => (color ? `\x1b[36m${s}\x1b[0m` : s);
  console.log('\n' + BANNER.map((line) => '  ' + paint(line)).join('\n'));
  console.log('\n        Private yes/no elections on Midnight · zero-knowledge ballots\n');
}

async function main() {
  printBanner();

  const rl = createInterface({ input: stdin, output: stdout });
  // readline swallows ^C at the prompt; route it to the process-level save-and-exit handler.
  rl.on('SIGINT', () => process.emit('SIGINT'));

  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run setup -- --network ${network}\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  // Fail fast — before a potentially long wallet sync — if the recorded contract isn't on this chain
  // (e.g. the local devnet was reset, or the state file points at another network's address).
  try {
    const onChain = await indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS)
      .queryContractState(deployment.address);
    if (!onChain) {
      console.error(`  ❌ No contract found at ${deployment.address} on ${network}.`);
      console.log(`     Redeploy with: npm run setup -- --network ${network}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.log(`  ⚠ Could not verify the contract on the indexer (${error instanceof Error ? error.message : error}); continuing.\n`);
  }

  let walletCtx: WalletContext;
  try {
    walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  } catch (error) {
    console.error(`  ❌ Could not start the ${network} wallet:`, error instanceof Error ? error.message : error);
    console.log(`     Check the node (${networkConfig.node}) and indexer (${networkConfig.indexer}) are reachable.`);
    console.log('     If you recently upgraded the SDK, delete .midnight-wallet-state/ to force a fresh sync.\n');
    throw error;
  }

  // Ctrl+C: checkpoint sync progress so the next run doesn't resync from scratch.
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    console.log('\n\n  Saving wallet state before exit... (Ctrl+C again to force)');
    try {
      await persistWalletState(network, walletCtx);
      await walletCtx.wallet.stop();
    } catch (error) {
      console.error('  ⚠ Could not save wallet state:', error instanceof Error ? error.message : error);
    }
    process.exit(130);
  });

  const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restoredCount > 0) {
    console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
  }

  console.log('  Syncing with network...\n');
  const syncStart = Date.now();
  const syncInterval = setInterval(() => {
    process.stdout.write(`\r  ⏳ Still syncing... (${Math.round((Date.now() - syncStart) / 1000)}s elapsed)   `);
  }, 5000);
  // Checkpoint during long syncs so a crash or network failure doesn't throw the progress away.
  const checkpointInterval = setInterval(() => {
    persistWalletState(network, walletCtx).catch(() => {});
  }, 60_000);
  await walletCtx.wallet.waitForSyncedState();
  clearInterval(syncInterval);
  clearInterval(checkpointInterval);
  process.stdout.write('\r  ✓ Synced with network.                                      \n');

  await persistWalletState(network, walletCtx);
  const providers = await createProviders(walletCtx);

  // Connect as the election authority (restores the admin secret from deploy).
  let admin: any;
  try {
    admin = await connect(providers, deployment.address, { privateStateId: ADMIN_PRIVATE_STATE_ID });
  } catch (error) {
    console.error('\n  ❌ Could not connect as the election authority:', error instanceof Error ? error.message : error);
    console.log('     Likely causes: midnight-level-db/ was deleted or moved, PRIVATE_STATE_PASSWORD changed');
    console.log('     since deploy, or the indexer is unreachable. Voting needs a working connection too.\n');
    throw error;
  }
  console.log('  ✅ Connected as election authority.\n');

  let running = true;
  while (running) {
    console.log('─── Menu ───────────────────────────────────────────────────────');
    console.log('  1. Election status (public ledger)');
    console.log('  2. Cast a ballot — For');
    console.log('  3. Cast a ballot — Against');
    console.log('  4. Close the election (authority only)');
    console.log('  5. Check wallet balance');
    console.log('  0. Exit\n');

    let choice: string;
    try {
      choice = await rl.question('  Your choice: ');
    } catch {
      // stdin closed (EOF / piped input ran out): leave the loop and save state.
      choice = '0';
    }

    switch (choice.trim()) {
      case '1': {
        console.log('\n  ── Public election state ──\n');
        try {
          const state = await readLedger(providers, deployment.address);
          console.log(describeLedger(state));
          console.log('\n  ℹ  Everything above is publicly readable on-chain. The tally can\n     be audited: ballots.size() must equal tallyFor + tallyAgainst.\n');
        } catch (error) {
          console.error('  ❌ Could not read the election from the indexer:', error instanceof Error ? error.message : error);
          console.log(`     Indexer: ${networkConfig.indexer} — try again in a moment.\n`);
        }
        break;
      }

      case '2':
      case '3': {
        const forVote = choice.trim() === '2';
        if (!(await requireProofServer())) break;
        try {
          const current = await readLedger(providers, deployment.address);
          if (current && Number(current.state) !== 0) {
            console.log('\n  ❌ This election is CLOSED — no more ballots can be cast.\n');
            break;
          }
        } catch {
          // Indexer hiccup: let the circuit itself enforce the OPEN check.
        }
        console.log(`\n  Casting a ${forVote ? 'FOR' : 'AGAINST'} ballot as a new anonymous voter...`);
        console.log('  (this may take 30-60 seconds: proof generation + submission)\n');

        // A fresh voter identity: brand-new ballot secret, own private state.
        const secret = newBallotSecret();
        const expectedId = ballotIdFromSecret(secret);
        console.log(`  local ballot id (predicted): 0x${toHex(expectedId)}`);

        try {
          const voter = await connect(providers, deployment.address, {
            privateStateId: `voter-${toHex(secret).slice(0, 16)}`,
            initialPrivateState: { ballotSecret: secret },
          });
          const tx = await withSubmitRetry('Ballot', () => voter.callTx.castVote(forVote));
          const ballotId = circuitOutputToBytes(tx);
          if (ballotId.length !== 32) {
            console.log(`\n  ⚠ The transaction succeeded but returned an unexpected ballot id (${ballotId.length} bytes).`);
            console.log('    The vote is counted; check option 1 to confirm the tally.');
          }
          const matched = Buffer.from(ballotId).equals(Buffer.from(expectedId));
          console.log(`\n  ✅ Ballot CAST (${forVote ? 'for' : 'against'})`);
          console.log(`  Transaction ID:  ${tx.public.txId}`);
          console.log(`  Block height:    ${tx.public.blockHeight}`);
          console.log(`  Disclosed ballot id:  0x${toHex(ballotId)}`);
          console.log(`  Matches predicted id? ${matched ? '✅ yes' : '❌ no'}`);
          console.log('\n  ℹ  The ballot id is the public nullifier for this ballot:');
          console.log('     persistentHash("pearpass:ballot:" || secret). Anyone can verify');
          console.log('     the ballot was cast by a unique entitled voter, but the secret');
          console.log('     itself never leaves private state — nobody can tell who voted.\n');
        } catch (error) {
          console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          const hint = explainFailure(error);
          if (hint) console.log(`  💡 ${hint}\n`);
          if (String(error).includes('already cast a ballot')) {
            console.log('  (this new secret collided with an existing id — near-impossible; try again)');
          }
        }
        break;
      }

      case '4': {
        if (!(await requireProofServer())) break;
        try {
          const current = await readLedger(providers, deployment.address);
          if (current && Number(current.state) !== 0) {
            console.log('\n  ℹ  The election is already CLOSED — nothing to do.\n');
            break;
          }
        } catch {
          // Indexer hiccup: fall through; the circuit rejects a double close anyway.
        }
        console.log('\n  Closing the election (requires the authority admin secret)...');
        try {
          const tx = await withSubmitRetry('Close', () => admin.callTx.closeElection());
          console.log(`\n  ✅ Election CLOSED`);
          console.log(`  Transaction ID:  ${tx.public.txId}`);
          console.log(`  Block height:    ${tx.public.blockHeight}\n`);
        } catch (error) {
          console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          const hint = explainFailure(error);
          if (hint) console.log(`  💡 ${hint}\n`);
          if (String(error).includes('not the election authority')) {
            console.log('  This terminal is not the authority — the admin secret lives in the');
            console.log('  private state created at deploy time.\n');
          }
        }
        break;
      }

      case '5': {
        try {
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const night = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dust = currentState.dust.balance(new Date());
          console.log(`\n  tNight: ${night.toLocaleString()}`);
          console.log(`  DUST:   ${dust.toLocaleString()}\n`);
        } catch (error) {
          console.error('\n  ❌ Could not read wallet balance:', error instanceof Error ? error.message : error, '\n');
        }
        break;
      }

      case '0':
        running = false;
        console.log('\n  👋 Goodbye!\n');
        break;

      default:
        console.log('\n  ❌ Invalid choice.\n');
    }
  }

  try {
    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('  ⚠ Could not cleanly save wallet state on exit:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('\n  ❌ PeerVote CLI crashed:', error instanceof Error ? error.message : error);
  if (process.env.DEBUG) console.error(error);
  else console.error('     (set DEBUG=1 for the full stack trace)');
  process.exit(1);
});