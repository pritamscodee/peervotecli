/**
 * Key derivation helpers.
 *
 * The contract's ball/dentity circuits compute persistentHash over the same
 * (domain, secret) pairs. These helpers mirror the Compact circuits exactly —
 * the deployer uses them to derive the public authority key from the admin
 * secret, and the CLI/tests use them to precompute expected ballot ids.
 *
 * Everything here is public & reproducible data; secrets never touch the chain.
 */
import { randomBytes } from 'node:crypto';
import { persistentHash, CompactTypeVector, Bytes32Descriptor } from '@midnight-ntwrk/compact-runtime';

const BALLOT_DOMAIN = 'pearpass:ballot:';
const AUTHORITY_DOMAIN = 'pearpass:authority:';

// Runtime type descriptor for Compact's Vector<2, Bytes<32>> — must match the
// type argument used in the contract's persistentHash/ballotId circuits.
export const BALLOT_ID_TYPE = new CompactTypeVector(2, Bytes32Descriptor);

export function pad32(domain: string): Uint8Array {
  const bytes = new TextEncoder().encode(domain);
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, 32));
  return out;
}

export function newBallotSecret(): Uint8Array {
  return randomBytes(32);
}

export function newAdminSecret(): Uint8Array {
  return randomBytes(32);
}

/** Decide the public ballot id (nullifier) for a ballot secret. */
export function ballotIdFromSecret(secret: Uint8Array): Uint8Array {
  return persistentHash(BALLOT_ID_TYPE, [pad32(BALLOT_DOMAIN), secret]);
}

/** Derive the public election-authority key from the admin secret. */
export function authorityPublicKey(adminSecret: Uint8Array): Uint8Array {
  return persistentHash(BALLOT_ID_TYPE, [pad32(AUTHORITY_DOMAIN), adminSecret]);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}