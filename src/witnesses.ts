/**
 * Private state + witness implementations for the private-election contract.
 *
 * Each "identity" (election authority or an anonymous voter) is a distinct
 * private state record. The witness implementations read the secrets out of
 * private state — inside the ZK proof — and the secrets themselves are never
 * written to the blockchain.
 */
import { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { Ledger } from '../contracts/managed/private-election/contract/index.js';

export type ElectionPrivateState = {
  /** The voter's 32-byte ballot secret. Set only on voter identities. */
  readonly ballotSecret?: Uint8Array;
  /** The election authority's admin secret. Set only on the deployer identity. */
  readonly adminSecret?: Uint8Array;
};

export const witnesses = {
  ballotSecret: ({
    privateState,
  }: WitnessContext<Ledger, ElectionPrivateState>): [ElectionPrivateState, Uint8Array] => {
    if (!privateState.ballotSecret) {
      throw new Error('ballotSecret witness called but this private state has no ballotSecret');
    }
    return [privateState, privateState.ballotSecret];
  },

  adminSecret: ({
    privateState,
  }: WitnessContext<Ledger, ElectionPrivateState>): [ElectionPrivateState, Uint8Array] => {
    if (!privateState.adminSecret) {
      throw new Error('adminSecret witness called but this private state has no adminSecret');
    }
    return [privateState, privateState.adminSecret];
  },
} as const;