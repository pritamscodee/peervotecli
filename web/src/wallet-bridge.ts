/**
 * Browser ↔ Lace bridge — DApp Connector only.
 *
 * This module deliberately imports nothing from the Midnight SDK at runtime
 * (only types), so the dashboard can boot instantly. Everything that needs
 * the ledger / WASM (balances, provider wiring, the circuit call) lives in
 * `lace-vote.ts` and is loaded lazily on first use.
 *
 * Wallets inject their Initial API under `window.midnight[<uuid>]` (API v4).
 * Injection happens from the extension's content script and can land after
 * this page's scripts run, so callers should poll via `waitForWallets`.
 */
import type { Configuration, ConnectedAPI, InitialAPI } from '@midnightntwrk/dapp-connector-api';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, '');
  const matches = cleaned.match(/.{1,2}/g);
  if (!matches) return new Uint8Array();
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/** Wallet instances implementing the v4 connector (`connect(networkId)`). */
export function listWallets(): InitialAPI[] {
  const injected = window.midnight as Record<string, unknown> | undefined;
  if (!injected) return [];
  return Object.values(injected).filter(
    (w): w is InitialAPI => !!w && typeof (w as InitialAPI).connect === 'function',
  );
}

/**
 * True when something is injected under `window.midnight` but none of it
 * speaks the v4 connector — i.e. an outdated Lace exposing the legacy
 * `mnLace.enable()` API, which cannot talk to ledger v8 / midnight-js 4.
 */
export function hasOnlyLegacyWallet(): boolean {
  const injected = window.midnight as Record<string, unknown> | undefined;
  if (!injected || Object.keys(injected).length === 0) return false;
  return listWallets().length === 0;
}

/** Poll for injected wallets for up to `ms` (extensions inject asynchronously). */
export async function waitForWallets(ms = 3000): Promise<InitialAPI[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const wallets = listWallets();
    if (wallets.length > 0 || Date.now() >= deadline) return wallets;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface WalletSession {
  api: ConnectedAPI;
  name: string;
  networkId: string;
  config: Configuration;
  shieldedAddress: string;
  unshieldedAddress: string;
  /** Hex-encoded coin public key (matches ledger-v8 `CoinPublicKey`). */
  coinPublicKey: string;
  /** Hex-encoded encryption public key (matches ledger-v8 `EncPublicKey`). */
  encryptionPublicKey: string;
}

/** Map DApp Connector `APIError`s to something a user can act on. */
export function describeConnectorError(err: unknown, networkId: string): string | null {
  const e = err as { type?: string; code?: string; reason?: string; message?: string } | null;
  if (!e || e.type !== 'DAppConnectorAPIError') return null;
  const reason = e.reason || e.message || '';
  switch (e.code) {
    case 'Rejected':
    case 'PermissionRejected':
      return 'You rejected the request in Lace.';
    case 'Disconnected':
      return 'Lace disconnected — unlock the wallet and connect again.';
    case 'InvalidRequest':
      if (/network\s*id\s*mismatch/i.test(reason)) {
        return `Lace is on a different network than this app, which runs on "${networkId}". ` +
          (networkId === 'undeployed'
            ? 'In Lace, switch the Midnight network to the local "Undeployed" network ' +
              '(node ws://127.0.0.1:9944, indexer http://127.0.0.1:8088/api/v4/graphql, ' +
              'proof server http://127.0.0.1:6300), then click Connect again.'
            : `In Lace → Settings → Network, switch to "${networkName(networkId)}", then click Connect again.`);
      }
      return `Lace refused the request (${reason || 'invalid request'}). ` +
        `Make sure Lace is set to the "${networkId}" network.`;
    default:
      return `Lace error (${e.code ?? 'unknown'}): ${reason}`;
  }
}

export async function connectWallet(wallet: InitialAPI, networkId: string): Promise<WalletSession> {
  const api = await wallet.connect(networkId);
  const [shielded, unshielded, config] = await Promise.all([
    api.getShieldedAddresses(),
    api.getUnshieldedAddress(),
    api.getConfiguration(),
  ]);
  return {
    api,
    name: wallet.name,
    networkId,
    config,
    shieldedAddress: shielded.shieldedAddress,
    unshieldedAddress: unshielded.unshieldedAddress,
    coinPublicKey: shielded.shieldedCoinPublicKey,
    encryptionPublicKey: shielded.shieldedEncryptionPublicKey,
  };
}

export function networkName(networkId: string): string {
  if (networkId === 'undeployed') return 'Local devnet';
  if (networkId === 'preview' || networkId === 'preprod') return `Midnight ${networkId}`;
  return networkId;
}
