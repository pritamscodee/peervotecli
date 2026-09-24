<div align="center">

```
██████╗ ███████╗███████╗██████╗ ██╗   ██╗ ██████╗ ████████╗███████╗
██╔══██╗██╔════╝██╔════╝██╔══██╗██║   ██║██╔═══██╗╚══██╔══╝██╔════╝
██████╔╝█████╗  █████╗  ██████╔╝██║   ██║██║   ██║   ██║   █████╗
██╔═══╝ ██╔══╝  ██╔══╝  ██╔══██╗╚██╗ ██╔╝██║   ██║   ██║   ██╔══╝
██║     ███████╗███████╗██║  ██║ ╚████╔╝ ╚██████╔╝   ██║   ███████╗
╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝   ╚═════╝    ╚═╝   ╚══════╝
                             C  L  I
```

### Anonymous, zero-knowledge yes/no voting — from your terminal, on Midnight.

Every ballot is a ZK proof. The only public trace of a vote is a one-way hashed nullifier.
**Votes stay secret. The tally stays auditable.**

[![CI](https://github.com/pritamscodee/peervotecli/actions/workflows/ci.yml/badge.svg)](https://github.com/pritamscodee/peervotecli/actions/workflows/ci.yml)
![Midnight](https://img.shields.io/badge/network-Midnight%20preprod-6f42c1)
![Compact](https://img.shields.io/badge/contract-Compact%20%E2%89%A5%200.23-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)
![Tests](https://img.shields.io/badge/unit%20tests-9%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

[Quick start](#-quick-start) · [Using the CLI](#-using-the-cli) · [How the ZK works](#-how-the-zero-knowledge-part-works) · [Privacy model](#-privacy-model) · [Troubleshooting](#-troubleshooting)

</div>

---

## ✨ What it is

**PeerVote CLI** is a terminal-first private election dApp built on the
[Midnight](https://midnight.network) blockchain (project codename *PearPass*).

- 🗳️ **One question, two answers.** An authority opens a yes/no election, and voters cast FOR or AGAINST ballots.
- 🕶️ **Anonymous ballots.** Each ballot comes with a zero-knowledge proof. The chain sees *that* a unique voter voted, but never *who*.
- 🚫 **No double voting.** Each voter secret maps to exactly one public nullifier, and the contract rejects repeats.
- 🔍 **Publicly auditable.** Anyone can check `ballots.size() == tallyFor + tallyAgainst`.
- 🔐 **Authority-only close.** Only the deployer can close the election, by proving knowledge of an admin secret that never leaves the machine.

> Idea from the Midnight idea list: **[Private Voting](PRODUCT_PROPOSAL.md)**

**Live on preprod**

| | |
|---|---|
| Contract address | `fea4e520a2cb499a602aa944dd45412118e0de6a360264bee16ca61c1eb99054` |
| Question | *"Should PearPass ship a private voting MVP?"* |

---

## 🚀 Quick start

### Requirements

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22 | Runs the CLI and the deploy scripts |
| Docker + Compose v2 | any recent | Runs the local **proof server** (and the devnet, if you use it) |
| Compact compiler | pinned in `.github/workflows/ci.yml` | Only needed if you change the contract (on Windows, compile inside WSL) |

### 1. Install

```bash
npm install
```

### 2. Pick a network and deploy

**Option A: local devnet (fast, no faucet)**

```bash
npm run setup
```

**Option B: Midnight preprod (public testnet)**

```bash
npm run setup -- --network preprod
```

`setup` does four things:
1. Starts the Docker services the network needs.
2. Compiles the contract.
3. Creates a wallet and prints its 24-word phrase.
4. Waits for funds, registers DUST, and deploys the election.

> ⏱️ **The first preprod run is slow.** A brand-new wallet has to scan the whole
> preprod history, and the DUST wallet is the slowest part (about 1.5M events,
> **roughly 30–40 minutes**). Progress is shown live:
>
> ```
> ⏳ Still syncing... (174s elapsed) — dust 163,838 / 1,560,975 (10.4%)
> ```
>
> The sync state is saved **every 60 seconds** to `.midnight-wallet-state/`, so an
> interrupted run picks up where it left off. After the first sync, every later
> command starts within seconds.

**Funding on preprod:** when setup prints *"Waiting for tNIGHT"*, paste the wallet address into
the [preprod faucet](https://midnight-tmnight-preprod.nethermind.dev). You can do this while
the sync is still running.

### 3. Vote

```bash
npm run cli
```

---

## 🖥️ Using the CLI

```
  ██████╗ ███████╗███████╗██████╗ ██╗   ██╗ ██████╗ ████████╗███████╗
  ...                                                     (cyan banner)

        Private yes/no elections on Midnight · zero-knowledge ballots

  ✅ Connected as election authority.

─── Menu ───────────────────────────────────────────────────────
  1. Election status (public ledger)
  2. Cast a ballot — For
  3. Cast a ballot — Against
  4. Close the election (authority only)
  5. Check wallet balance
  0. Exit
```

| Key | Action | Cost | Notes |
|---|---|---|---|
| `1` | Show question, state, tallies, ballot count | free (read-only) | Also prints the audit check |
| `2` / `3` | Cast FOR / AGAINST | DUST fee, ~30–60 s | Each ballot uses a **fresh anonymous voter identity** |
| `4` | Close the election | DUST fee | **Irreversible.** Authority only. |
| `5` | tNIGHT and DUST balance | free | DUST regenerates over time from your tNIGHT |
| `0` | Exit | | Saves wallet sync state |

**A typical session:** `1` → `2` → `3` → `2` → `1` (tally is 2–1) → `4` → `1` (closed, final result).

After each ballot you'll see:

```
  ✅ Ballot CAST (for)
  Transaction ID:  00ab…
  Block height:    2691871
  Disclosed ballot id:  0x5c1e…
  Matches predicted id? ✅ yes
```

The **ballot id** is the public nullifier. The CLI computes it locally *before*
submitting and checks it matches what the chain disclosed.

**Resilient submission.** Public RPC nodes sometimes drop websockets mid-submit.
The CLI retries a vote or close up to 4 times (10 s, 20 s, 30 s back-off). This is
safe: a retry reuses the same ballot secret, so it can't produce a second vote.

### Other commands

```bash
npm run check-balance     # wallet balances on the active network
npm run network           # show active network + last deploy
npm run network preprod   # switch the active network
npm run election:demo     # scripted: 5 voters, double-vote rejection, close, audit
npm run proof-server:start / proof-server:stop
npm run clean             # ⚠️ DELETES .midnight-state.json (wallet seed!), wallet
                          #    checkpoints and contracts/managed — back up first
```

---

## 🧠 How the zero-knowledge part works

```
        VOTER (your machine)                              MIDNIGHT LEDGER (public)
 ┌────────────────────────────────┐                ┌──────────────────────────────────┐
 │ ballotSecret = random 32 bytes │                │ question        "Should …?"      │
 │   (private state, never sent)  │                │ state           OPEN | CLOSED    │
 │                                │   ZK proof +   │ tallyFor        Counter          │
 │ castVote(choice) circuit:      │ ─────────────▶ │ tallyAgainst    Counter          │
 │   id = H("pearpass:ballot:"‖s) │   disclosed id │ ballots         Set<Bytes<32>>   │
 │   assert id ∉ ballots          │                │ authority       Bytes<32>        │
 │   tally[choice] += 1           │                └──────────────────────────────────┘
 │   ballots.insert(id)           │                         ▲
 └────────────────────────────────┘                         │ proof verified by
          │ proof generated by                              │ every node
          ▼                                                 │
 ┌────────────────────────────────┐                         │
 │ proof server (Docker, :6300)   │ ────────────────────────┘
 └────────────────────────────────┘
```

The contract (`contracts/private-election.compact`) has two circuits:

**`castVote(choice)`**
1. Checks the election is `OPEN`.
2. Reads the voter's `ballotSecret` through a **private witness**. It exists only inside the proof.
3. Computes and **discloses** `ballotId = persistentHash("pearpass:ballot:" ‖ secret)`.
4. Rejects the vote if that id is already in `ballots` (no double votes).
5. Increments `tallyFor` or `tallyAgainst` and records the id.

**`closeElection()`**
- Proves `persistentHash("pearpass:authority:" ‖ adminSecret) == authority`.
- The admin secret was generated at deploy time and never leaves the local private-state DB.

`src/keys.ts` mirrors both hashes in TypeScript, so the CLI can predict a ballot
id and check it against the chain. The unit tests check that the mirror matches.

---

## 🛡️ Privacy model

Everything on the ledger is public, so the design decides exactly what gets published.

| ✅ An observer **can** see | ❌ An observer **cannot** see |
|---|---|
| The question and whether it's open or closed | **Who** voted |
| The aggregate `tallyFor` / `tallyAgainst` | **How** any individual voted |
| One opaque nullifier per ballot | The secret behind any nullifier (the hash is one-way) |
| The authority's *public* key | The authority's admin secret |
| Tx ids and block heights | Any link between two ballots |

**Audit invariant:** `ballots.size() == tallyFor + tallyAgainst`. Nobody can
quietly add, drop or flip a vote without breaking it.

> ⚠️ **Honest limitation:** this MVP doesn't restrict *who* may vote. Anyone who
> can reach the contract can cast a ballot with a fresh secret. The CLI simulates
> many voters from one terminal. A production version would add an eligibility
> list (for example, a Merkle root of registered voter commitments) and prove membership inside `castVote`.

---

## 🧪 Tests

```bash
npm test               # 9 unit tests — hash mirrors, nullifier determinism, key derivation
npm run test:e2e       # live network: contract state read-back
npm run election:demo  # full lifecycle incl. double-vote rejection + audit invariant
```

```
ℹ tests 9
ℹ suites 5
ℹ pass 9
ℹ fail 0
```

CI (`.github/workflows/ci.yml`) recompiles the contract, fails on stale artifacts,
type-checks, runs the unit tests, then boots a devnet and runs the e2e and demo.

---

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Still syncing...` for 30+ min on preprod | First-time wallet sync of ~1.5M DUST events | Normal. Watch the `dust … (%)` counter. Later runs resume from the checkpoint. |
| `dust` % stops moving for 5+ minutes | Sync stream stalled after an indexer disconnect | Ctrl+C and rerun. It resumes from the last 60 s checkpoint. |
| `Wallet.Sync: [object Object]` stack trace | Indexer websocket dropped | Harmless. The SDK reconnects on its own. |
| `SubmissionError … Normal Closure` | RPC node closed the socket mid-submit | The CLI retries automatically. If all 4 attempts fail, wait a minute and retry. |
| `Not enough Dust` | DUST still generating or spent | Check with `5`, wait a minute, retry. |
| `No deploy on file for network preprod` | Setup hasn't finished (or was run for another network) | Let `npm run setup -- --network preprod` complete. |
| `Proof server unreachable` | Docker container not running | `npm run proof-server:start` |
| Two deploys fighting / DUST conflicts | Setup or CLI running in two terminals at once | Run **one** process per wallet at a time. |

---

## 📁 Project layout

```
contracts/
  private-election.compact   Compact contract (castVote, closeElection)
  managed/                   compiled circuits + ZK keys (committed on purpose)
src/
  cli.ts                     ← PeerVote CLI (menu, banner, retrying submit)
  setup.ts / deploy.ts       one-command setup + deploy with live sync progress
  wallet.ts / wallet-state.ts  wallet construction, sync tuning, checkpoints
  network.ts                 networks, BIP-39 wallets, deploy records
  keys.ts                    TypeScript mirrors of the contract's hash circuits
  contract.ts / witnesses.ts contract binding + private witnesses
tests/keys.test.ts           unit tests
scripts/                     demo, e2e check, clean, dev launcher
docker-compose.yml           proof server (+ local node & indexer for devnet)
web/                         optional browser dashboard (not needed for the CLI)
```

---

## 🔑 Secrets & local state

These are all git-ignored. **Back them up and don't share them.**

| Path | Contains | If lost |
|---|---|---|
| `.midnight-state.json` | Wallet seed + 24-word phrase, deploy addresses | Wallet recoverable only from the phrase |
| `midnight-level-db/` | **Admin secret** (needed to close the election), voter private states | You can no longer close the election |
| `.midnight-wallet-state/` | Sync checkpoints | Next run re-syncs from scratch (slow) |
| `*.log` | Deploy output, **may include the recovery phrase** | Delete; never commit or share |

---

## ✅ Submission checklist (Midnight build challenge — Level 2)

- [x] Complete README with privacy model
- [x] Working dApp on Midnight: Compact contract + CLI, **deployed to preprod**
- [x] ≥ 3 passing tests: **9 unit tests** + e2e + lifecycle demo
- [x] CI/CD workflow — badge live at pritamscodee/peervotecli
- [x] Idea from the approved list: [Private Voting](PRODUCT_PROPOSAL.md)
- [ ] 1-minute demo video: `npm run cli` → `1` → vote ×3 → `1` → `4` → `1`
- [ ] X profile link

## License

MIT
