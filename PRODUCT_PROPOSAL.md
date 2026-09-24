# Product Proposal — Private Voting (Midnight idea list)

**Submission for the Midnight build challenge (idea-list approval).**

- **Challenge idea (chosen):** *Private Voting — anonymous ballots with publicly verifiable tallies*
- **Product name:** PearPass
- **Status:** draft for idea approval
- **Date:** 2026-09-24

---

## 1. Idea / one-liner

An on-chain yes/no election where every ballot is a zero-knowledge proof:
voters stay anonymous, votes cannot be copied, and the final tally is public
and independently verifiable.

## 2. Problem

Elections and polls are a classic privacy problem:

- Voters want to express a **private** choice (avoid coercion, doxxing,
  social pressure, retaliation).
- Organizers/citizens want to **verify the result** — that the count matches
  the ballots and that nobody voted twice.

Traditional approaches break one side: a public ballot is verifiable but not
private; a private ballot requires trusting a central counter.

## 3. Solution

PearPass runs the election entirely on Midnight so no central party is trusted:

- **Private ballots.** Each vote produces a zero-knowledge proof over a secret
  that never leaves the voter's private state. The chain only ever sees a
  hashed **nullifier** — an opaque id that proves "a unique entitled voter
  cast once" without revealing who or what they chose.
- **Public, verifiable tally.** The ledger stores `tallyFor`, `tallyAgainst`,
  and the ballot nullifier set. The contract **enforces**
  `ballots == tallyFor + tallyAgainst`, so the tally is always auditable and
  tamper-evident.
- **Double-vote protection.** Reuse of the same nullifier is rejected on-chain,
  while *unlinkability* is preserved because each ballot uses its own identity.

## 4. Why Midnight (how the privacy model fits)

Midnight's model — a public `Ledger` plus **private `ContractState`** revealed
only through ZK witnesses — is exactly what private voting needs:

- The **ledger stores the aggregate** (tally, nullifier set, authority key).
- Each voter's **secret lives in private state** and enters the proof only
  through a witness, never through the ledger.
- We disclose through `closeElection`/`castVote` circuits *just enough*: a
  nullifier plus the per-call witnesses. Nothing else leaks.

**What an observer can learn:** the question, the aggregate tally, the ballot
nullifiers, and that `ballots == for + against`.

**What an observer cannot learn:** who voted, what any individual voted, any
secret behind a nullifier, or any link between a voter identity and a ballot.

## 5. MVP scope (v1)

- [x] Compact contract: `create`, `castVote(for|against)`, `closeElection`
- [x] Local devnet tooling (node + indexer + proof-server via Docker)
- [x] Deploy / setup / CLI (`npm run setup`, `npm run cli`)
- [x] Web dashboard with landing page (tail live tally, cast ballots, close)
- [x] Automated demo + audit invariant checks
- [x] Unit tests (9) + CI/CD (compile + test + e2e on devnet)

## 6. Out of scope (non-goals for v1)

- Threshold/ranked voting, multiple ballot options, voter registration/
  credentials for on-chain-verified identity (an allow-list could be a
  follow-up idea — see idea list).
- Permissionless creation of elections by non-authorities.
- Real-value token involvement or mainnet-type guarantees.

## 7. Follow-ups / stretch

- Public preview build + hosted demo (Vercel/Netlify) with Lace-connected
  voting.
- Receipt/audit store (already scaffolded: Postgres receipts vs on-chain tally).
- More question types and an eligibility gate circuit.

## 8. Risks / open questions

- Proof generation latency on a real network (mitigated by the proof server).
- Wallet-funding UX for voters (faucet tNIGHT on public nets).
- Scaling the nullifier set to large member counts.