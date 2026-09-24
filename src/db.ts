/**
 * Receipt / audit store for PearPass.
 *
 * The Midnight ledger only keeps an AGGREGATE tally (tallyFor/tallyAgainst
 * counters) plus the set of disclosed ballot nullifiers — individual choices
 * exist only in the voter's receipt. This module stores those receipts in an
 * external Postgres database (Neon) so the election can be independently
 * audited:
 *
 *   stored receipts (per-vote choice)  ⇄  on-chain aggregate tally
 *
 * The connection string is read from DATABASE_URL (.env is gitignored).
 * All writes are best-effort: if the store is unreachable, the DApp continues;
 * only the audit script requires the database.
 *
 * Only PUBLIC data is stored (ballot ids, tx ids, tallies) — never secrets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

let sql: Sql | undefined;

export interface ElectionRecord {
  network: string;
  contractAddress: string;
  question: string;
  authorityKey: string;
}

export interface ReceiptRecord {
  contractAddress: string;
  ballotId: string;
  choice: 'for' | 'against';
  txId: string;
  blockHeight?: number;
}

export interface FinalizeRecord {
  contractAddress: string;
  state: number;
  tallyFor: number;
  tallyAgainst: number;
  ballotsCount: number;
}

/** Returns the DATABASE_URL (loading gitignored .env on demand) or undefined. */
export function getDatabaseUrl(): string | undefined {
  if (!process.env.DATABASE_URL) {
    try {
      if (typeof process.loadEnvFile === 'function') {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          process.loadEnvFile(envPath);
        }
      }
    } catch {
      // .env is optional; the audit store is best-effort.
    }
  }
  return process.env.DATABASE_URL;
}

export function isAuditStoreEnabled(): boolean {
  return Boolean(getDatabaseUrl());
}

function getSql(): Sql {
  const url = getDatabaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the Neon receipts/audit database (e.g. in .env).',
    );
  }
  if (!sql) sql = neon(url);
  return sql;
}

/** Creates the receipts/audit schema (idempotent). */
export async function initAuditStore(): Promise<void> {
  const q = getSql();
  await q/* sql */ `
    CREATE TABLE IF NOT EXISTS elections (
      network          text        NOT NULL,
      contract_address text        PRIMARY KEY,
      question         text        NOT NULL,
      authority_key    text        NOT NULL,
      state            integer     NOT NULL DEFAULT 0,
      tally_for        bigint      NOT NULL DEFAULT 0,
      tally_against    bigint      NOT NULL DEFAULT 0,
      ballots_count    bigint      NOT NULL DEFAULT 0,
      created_at       timestamptz NOT NULL DEFAULT now(),
      closed_at        timestamptz
    );
  `;
  await q/* sql */ `
    CREATE TABLE IF NOT EXISTS ballot_receipts (
      id               bigserial   PRIMARY KEY,
      contract_address text        NOT NULL REFERENCES elections(contract_address) ON DELETE CASCADE,
      ballot_id        text        NOT NULL,
      choice           text        NOT NULL CHECK (choice IN ('for', 'against')),
      tx_id            text        NOT NULL,
      block_height     bigint,
      cast_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (contract_address, ballot_id)
    );
  `;
  await q/* sql */ `
    CREATE INDEX IF NOT EXISTS ballot_receipts_by_election
      ON ballot_receipts (contract_address);
  `;
}

export async function recordElection(record: ElectionRecord): Promise<void> {
  const q = getSql();
  await q/* sql */ `
    INSERT INTO elections (network, contract_address, question, authority_key)
    VALUES (${record.network}, ${record.contractAddress}, ${record.question}, ${record.authorityKey})
    ON CONFLICT (contract_address) DO NOTHING;
  `;
}

export async function recordReceipt(record: ReceiptRecord): Promise<void> {
  const q = getSql();
  await q/* sql */ `
    INSERT INTO ballot_receipts
      (contract_address, ballot_id, choice, tx_id, block_height)
    VALUES
      (${record.contractAddress}, ${record.ballotId}, ${record.choice}, ${record.txId}, ${record.blockHeight ?? null})
    ON CONFLICT (contract_address, ballot_id) DO NOTHING;
  `;
}

export async function finalizeElection(record: FinalizeRecord): Promise<void> {
  const q = getSql();
  await q/* sql */ `
    UPDATE elections
    SET state = ${record.state},
        tally_for = ${record.tallyFor},
        tally_against = ${record.tallyAgainst},
        ballots_count = ${record.ballotsCount},
        closed_at = now()
    WHERE contract_address = ${record.contractAddress};
  `;
}

export interface StoredElection {
  contract_address: string;
  question: string;
  state: number;
  tally_for: string;
  tally_against: string;
  ballots_count: string;
}

export interface StoredReceiptCounts {
  for: number;
  against: number;
}

export async function getStoredElection(
  contractAddress: string,
): Promise<StoredElection | null> {
  const q = getSql();
  const rows = (await q/* sql */ `
    SELECT contract_address, question, state, tally_for, tally_against, ballots_count
    FROM elections
    WHERE contract_address = ${contractAddress};
  `) as unknown as Array<StoredElection>;
  return rows[0] ?? null;
}

export async function getStoredReceiptCounts(
  contractAddress: string,
): Promise<StoredReceiptCounts> {
  const q = getSql();
  const rows = (await q/* sql */ `
    SELECT choice, COUNT(*)::int AS count
    FROM ballot_receipts
    WHERE contract_address = ${contractAddress}
    GROUP BY choice;
  `) as unknown as Array<{ choice: string; count: number }>;
  const forRow = rows.find((r) => r.choice === 'for');
  const againstRow = rows.find((r) => r.choice === 'against');
  return {
    for: forRow ? forRow.count : 0,
    against: againstRow ? againstRow.count : 0,
  };
}