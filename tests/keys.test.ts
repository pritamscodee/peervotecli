import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBallotSecret,
  newAdminSecret,
  ballotIdFromSecret,
  authorityPublicKey,
  pad32,
  toHex,
} from '../src/keys';

describe('pad32', () => {
  it('right-pads a short domain string to 32 bytes', () => {
    const out = pad32('pearpass:ballot:');
    assert.equal(out.length, 32);
    assert.equal(Buffer.from(out.subarray(0, 16)).toString(), 'pearpass:ballot:');
    assert.ok(out.subarray(16).every((b) => b === 0));
  });

  it('is deterministic', () => {
    assert.deepEqual(pad32('x'), pad32('x'));
  });
});

describe('newBallotSecret', () => {
  it('returns unique 32-byte secrets', () => {
    const a = newBallotSecret();
    const b = newBallotSecret();
    assert.equal(a.length, 32);
    assert.equal(b.length, 32);
    assert.notDeepEqual(a, b);
  });
});

describe('ballotIdFromSecret', () => {
  it('derives the same ballot id for the same secret (determinism = nullifier)', () => {
    const secret = newBallotSecret();
    assert.deepEqual(ballotIdFromSecret(secret), ballotIdFromSecret(secret));
  });

  it('derives different ids for different secrets', () => {
    assert.notDeepEqual(ballotIdFromSecret(newBallotSecret()), ballotIdFromSecret(newBallotSecret()));
  });

  it('produces a 32-byte output', () => {
    assert.equal(ballotIdFromSecret(newBallotSecret()).length, 32);
  });
});

describe('domain separation', () => {
  it('ballot id and authority key are distinct values (distinct domains)', () => {
    const secret = newBallotSecret();
    assert.notDeepEqual(ballotIdFromSecret(secret), authorityPublicKey(secret));
  });

  it('authority key is deterministic for a given admin secret', () => {
    const admin = newAdminSecret();
    assert.deepEqual(authorityPublicKey(admin), authorityPublicKey(admin));
  });
});

describe('toHex', () => {
  it('formats bytes as lowercase hex', () => {
    assert.equal(toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), 'deadbeef');
  });
});