/**
 * Browser-safe ballot helpers — mirror of src/keys.ts with `node:crypto`
 * replaced by the Web Crypto API.
 *
 * The contract's circuits compute persistentHash over the same
 * (domain, secret) pairs. Precomputing the expected ballot id (nullifier)
 * lets the dashboard prove that the browser's ZK call opened exactly the
 * ballot it claims, without the secret ever leaving the tab.
 */
import { persistentHash, CompactTypeVector, Bytes32Descriptor } from '@midnight-ntwrk/compact-runtime';

const BALLOT_DOMAIN = 'pearpass:ballot:';

export const BALLOT_ID_TYPE = new CompactTypeVector(2, Bytes32Descriptor);

export function pad32(domain: string): Uint8Array {
  const bytes = new TextEncoder().encode(domain);
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, 32));
  return out;
}

export function newBallotSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

/** Decide the public ballot id (nullifier) for a ballot secret. */
export function ballotIdFromSecret(secret: Uint8Array): Uint8Array {
  return persistentHash(BALLOT_ID_TYPE, [pad32(BALLOT_DOMAIN), secret]);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}