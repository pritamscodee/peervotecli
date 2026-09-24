/**
 * In-browser circuit call via Lace — the SDK-heavy half of the wallet bridge.
 *
 * Loaded lazily (`await import('./lace-vote')`) so the ledger / onchain-runtime
 * WASM never blocks dashboard boot. A single provider set is assembled per
 * wallet session:
 *   • privateStateProvider — IndexedDB (level), keyed by the shielded address
 *   • publicDataProvider   — the wallet's configured indexer (GraphQL + WS)
 *   • zkConfigProvider     — FetchZkConfigProvider, ZK artifacts over HTTP
 *   • proofProvider        — wallet-side proving (`getProvingProvider`) when
 *                            offered, otherwise the proof server over HTTP
 *   • walletProvider       — keys + `balanceUnsealedTransaction` round-trip
 *   • midnightProvider     — `submitTransaction` relaying
 *
 * Every secret that pays for the transaction stays in Lace: we only send
 * serialized bytes out and deserialize what comes back.
 */
import './polyfills';
import { Transaction, nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { ConnectedAPI } from '@midnightntwrk/dapp-connector-api';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { compiledContract } from './contract';
import { newBallotSecret, ballotIdFromSecret, toHex, bytesEqual } from './keys';
import { bytesToHex, hexToBytes, type WalletSession } from './wallet-bridge';

// Must satisfy midnight-js `validatePassword`: ≥16 chars, ≥3 character
// classes, no runs/sequences. It only encrypts this tab's ballot secrets in
// IndexedDB; the wallet's keys never touch it.
const BROWSER_PRIVATE_STATE_PASSWORD = 'PearPass#Browser-Ballots!v8';

export interface WalletBalances {
  tNight: string;
  shielded: string;
  dust: string;
  dustCap: string;
}

/** Read the connected wallet's balances via the DApp Connector. */
export async function readWalletBalances(api: ConnectedAPI): Promise<WalletBalances> {
  const [unshielded, dust, shielded] = await Promise.all([
    api.getUnshieldedBalances(),
    api.getDustBalance(),
    api.getShieldedBalances(),
  ]);
  const nightKey = nativeToken().raw;
  return {
    tNight: (unshielded[nightKey] ?? 0n).toString(),
    shielded: Object.values(shielded).reduce<bigint>((sum, value) => sum + BigInt(value), 0n).toString(),
    dust: dust.balance.toString(),
    dustCap: dust.cap.toString(),
  };
}

export interface BrowserProviderOptions {
  /** Absolute base URL for ZK artifacts, e.g. http://localhost:3001/zkconfig/private-election */
  zkConfigBaseURL: string;
  indexerFallback?: string;
  indexerWsFallback?: string;
  proofServerFallback?: string;
}

export type BrowserProviders = Awaited<ReturnType<typeof buildBrowserProviders>>;

export async function buildBrowserProviders(session: WalletSession, opts: BrowserProviderOptions) {
  const { config } = session;
  // midnight-js refuses any contract/tx operation until the network id is set
  // (the backend does this in src/wallet.ts; the browser needs it too).
  setNetworkId(session.networkId);

  const indexerUri = config.indexerUri || opts.indexerFallback;
  const indexerWsUri = config.indexerWsUri || opts.indexerWsFallback;
  const proverServerUri = config.proverServerUri || opts.proofServerFallback;

  if (!indexerUri || !indexerWsUri) {
    throw new Error(
      'The wallet did not configure indexer endpoints (indexerUri/indexerWsUri). ' +
        'Point the wallet at the network services and connect again.',
    );
  }

  const zkConfigProvider = new FetchZkConfigProvider<string>(opts.zkConfigBaseURL, fetch.bind(window));
  const publicDataProvider = indexerPublicDataProvider(indexerUri, indexerWsUri, WebSocket as never);

  let proofProvider;
  let provingVia: string;
  try {
    const provingProvider = await session.api.getProvingProvider(zkConfigProvider);
    proofProvider = createProofProvider(provingProvider);
    provingVia = 'Lace proving provider';
  } catch {
    if (!proverServerUri) {
      throw new Error(
        'Proving needs a proof server the wallet has not configured (config.proverServerUri absent) ' +
          'and the wallet offered no built-in proving provider. Set the proof server ' +
          '(local devnet: http://127.0.0.1:6300) in the wallet and reconnect.',
      );
    }
    proofProvider = httpClientProofProvider(proverServerUri, zkConfigProvider);
    provingVia = proverServerUri;
  }

  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: 'private-election-state',
    accountId: session.shieldedAddress,
    privateStoragePasswordProvider: () => BROWSER_PRIVATE_STATE_PASSWORD,
  });

  const walletProvider = {
    getCoinPublicKey: () => session.coinPublicKey,
    getEncryptionPublicKey: () => session.encryptionPublicKey,
    async balanceTx(tx: { serialize(): Uint8Array }) {
      const result = await session.api.balanceUnsealedTransaction(bytesToHex(tx.serialize()));
      return Transaction.deserialize('signature', 'proof', 'binding', hexToBytes(result.tx));
    },
  };

  const midnightProvider = {
    async submitTx(tx: { serialize(): Uint8Array; identifiers(): string[] }) {
      const [txId] = tx.identifiers();
      if (txId === undefined) {
        throw new Error('The finalized transaction carries no identifier; nothing to watch once submitted.');
      }
      await session.api.submitTransaction(bytesToHex(tx.serialize()));
      return txId;
    },
  };

  return {
    provingVia,
    providers: {
      privateStateProvider,
      publicDataProvider,
      zkConfigProvider,
      proofProvider,
      walletProvider,
      midnightProvider,
    },
  };
}

function circuitOutputToBytes(result: { private?: { output?: { value?: Array<Uint8Array> } } }): Uint8Array {
  const value: Array<Uint8Array> = result?.private?.output?.value ?? [];
  const total = value.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of value) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface LaceVoteResult {
  txId: string;
  ballotId: string;
  expectedId: string;
  matched: boolean;
}

/**
 * Cast one ballot as a brand-new voter identity: fresh ballot secret, its own
 * private state, proof orchestrated in this tab, Lace balances/signs/submits.
 */
export async function castVoteViaLace(
  providers: BrowserProviders['providers'],
  contractAddress: string,
  forVote: boolean,
  onStep: (msg: string) => void,
): Promise<LaceVoteResult> {
  const secret = newBallotSecret();
  const expectedId = ballotIdFromSecret(secret);
  onStep('local ballot id (predicted): <code>0x' + toHex(expectedId) + '</code>');

  onStep('Reading the deployed contract from the indexer…');
  const voter = await findDeployedContract(
    providers as never,
    {
      compiledContract: compiledContract as never,
      contractAddress,
      privateStateId: 'web-voter-' + toHex(secret).slice(0, 16),
      initialPrivateState: { ballotSecret: secret },
    } as never,
  );

  onStep('Proving <code>castVote</code> and asking Lace to balance &amp; sign — approve the request in the Lace popup…');
  const tx = await (voter as unknown as { callTx: { castVote(b: boolean): Promise<never> } }).callTx.castVote(forVote);
  const ballotId = circuitOutputToBytes(tx);
  return {
    txId: String((tx as { public: { txId: string } }).public.txId),
    ballotId: toHex(ballotId),
    expectedId: toHex(expectedId),
    matched: bytesEqual(ballotId, expectedId),
  };
}
