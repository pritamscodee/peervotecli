/**
 * PearPass dashboard — port 3000 (Vite).
 *
 * Extends the original static dashboard with a Lace wallet panel and an
 * in-browser circuit call: when a wallet is connected, Vote buttons run
 * `castVote` through `findDeployedContract` inside this tab — the ballot
 * secret is generated here, the proof is orchestrated here, and Lace signs /
 * balances / relays the transaction. Without a wallet, Voting falls back to
 * the backend API (proofs generated via the local proof server).
 */
import './polyfills';
import type { InitialAPI } from '@midnightntwrk/dapp-connector-api';

import {
  listWallets,
  waitForWallets,
  hasOnlyLegacyWallet,
  connectWallet,
  describeConnectorError,
  networkName,
  type WalletSession,
} from './wallet-bridge';
import type { BrowserProviders } from './lace-vote';

// The Midnight SDK (ledger + onchain-runtime WASM, several MB) is only needed
// for the Lace path, so it is loaded on demand. Importing it statically made
// this module finish evaluating *after* DOMContentLoaded (WASM top-level
// await), so the boot handler never ran and the whole dashboard sat dead.
let laceModule: Promise<typeof import('./lace-vote')> | null = null;
function loadLace(): Promise<typeof import('./lace-vote')> {
  if (!laceModule) {
    laceModule = import('./lace-vote').catch((err) => {
      laceModule = null;
      throw err;
    });
  }
  return laceModule;
}

// Backend API base URL (port 3001, CORS-enabled). Override with
// window.PEARPASS_API_URL if the API runs elsewhere.
const API_BASE = window.PEARPASS_API_URL || 'http://localhost:3001';
let zkConfigBase = API_BASE + '/zkconfig/private-election';

// Hosted (Vercel) mode: no local API reachable. The dashboard then reads the tally straight from
// the public indexer, serves ZK keys from its own origin, and votes through Lace in the browser.
let standalone = false;
let electionCfg: import('./lace-vote').PublicElectionConfig | null = null;

// The busy overlay must never spin forever: if an operation has not settled
// by the hard cap it is reported as failed so the UI (and the Connect button)
// unblocks. The intermediate thresholds switch the overlay to a diagnostic
// hint when the wallet looks stuck syncing against the indexer.
const BUSY_HARD_TIMEOUT_MS = 180_000;
// Lace path = SDK load + in-browser/wallet proving + user approval popup.
const WALLET_VOTE_TIMEOUT_MS = 240_000;
// Includes the time the user needs to approve the Lace connect popup.
const WALLET_CONNECT_TIMEOUT_MS = 120_000;
const STUCK_NOTICE_AT_MS = 45_000;
const STUCK_TOAST_AT_MS = 120_000;

let state: { [key: string]: unknown } | null = null;
let busy = false;
let pollTimer: number | null = null;
let busyStart = 0;
let busyTicker: number | null = null;

let wallet: InitialAPI | null = null;
let session: WalletSession | null = null;
let providers: BrowserProviders['providers'] | null = null;

// ---------- tiny helpers ----------

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c;
  });
}

function fmtTime(d: number): string {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addLog(kind: string, html: string): void {
  const log = $('log');
  if (!log) return;
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = '<span class="time">' + fmtTime(Date.now()) + '</span>' + html;
  log.insertBefore(li, log.firstChild as Node | null);
  while (log.children.length > 40) log.removeChild(log.lastChild as Node);
}

let toastTimer: number | null = null;
function toast(msg: string, isErr?: boolean): void {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 5000);
}

function shortAddr(addr: string | undefined): string {
  if (!addr) return '—';
  return addr.length > 22 ? addr.slice(0, 10) + '…' + addr.slice(-6) : addr;
}

/**
 * Reject `p` once `ms` elapses without settlement. The underlying promise is
 * left running (the tx may still land on-chain); we just stop waiting on the
 * UI side so the overlay never spins forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (ms <= 0) {
      p.then(resolve, reject);
      return;
    }
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the operation may still land on-chain.`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Unwrap error values into a human message. Midnight's wallet-sdk / effect
 * errors arrive as tagged reasons (e.g. `Wallet.Sync`) whose `.message` is
 * just `[object Object]` — dig into `cause`, `error`, and enumerable fields so
 * the dashboard shows the real reason instead of an object dump.
 */
function errorMessage(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const direct = (obj as { message?: unknown }).message;
    if (typeof direct === 'string' && direct && direct !== '[object Object]') return direct;
    if (depth < 4) {
      for (const key of ['cause', 'error', 'reason'] as const) {
        const inner = obj[key];
        if (inner !== null && inner !== undefined && inner !== obj) {
          const msg = errorMessage(inner, depth + 1);
          if (msg && msg !== '[object Object]') return msg;
        }
      }
    }
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === err) continue;
      if (typeof v === 'string' && v && v !== '[object Object]') return v;
    }
    if (typeof obj._tag === 'string') return obj._tag;
    return '[object Object]';
  }
  return String(err);
}

function statusString(): string {
  return (state as { stateLabel?: string })?.stateLabel ?? String((state as { state?: number })?.state ?? '');
}

// ---------- voting mode ----------
//
// The proven path on a local devnet is the backend proof server (/api/vote,
// ~20s). The in-browser Lace circuit call is opt-in: on some setups (local
// network, old Lace) it hangs because the wallet cannot sync against the
// indexer (repeated Wallet.Sync errors). Default stays 'backend' so voting
// works even when Lace misbehaves.

let voteMode: 'backend' | 'wallet' = 'backend';

function modeLabel(mode: 'backend' | 'wallet'): string {
  return mode === 'wallet' ? 'in-browser via Lace' : 'backend proof server (recommended)';
}

function syncVotingHint(): void {
  const hint = $('votingHint');
  if (!hint || !state) return;
  if ((state as { state?: number }).state !== 0) { hint.textContent = 'election closed'; return; }
  hint.textContent = voteMode === 'wallet'
    ? (session ? 'voting in your browser via Lace' : 'Lace not connected — votes will use the backend')
    : 'anonymous (backend proof server)';
}

function wireVoteMode(): void {
  const mode = $('voteMode');
  if (!mode) return;
  mode.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-mode]') as HTMLButtonElement | null;
    if (!btn) return;
    setVoteMode(btn.dataset.mode === 'wallet' ? 'wallet' : 'backend');
    addLog('info', 'Voting mode: <strong>' + esc(modeLabel(voteMode)) + '</strong>.');
  });
}

function setVoteMode(next: 'backend' | 'wallet'): void {
  voteMode = next;
  const mode = $('voteMode');
  if (mode) {
    for (const opt of mode.querySelectorAll<HTMLButtonElement>('.vm-opt')) {
      const on = opt.dataset.mode === voteMode;
      opt.classList.toggle('is-active', on);
      opt.setAttribute('aria-pressed', String(on));
    }
  }
  syncVotingHint();
}

// ---------- api ----------

async function api(path: string, options?: RequestInit): Promise<{ ok: boolean; [key: string]: unknown }> {
  const res = await fetch(API_BASE + path, options);
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'Invalid response from server' };
  }
}

async function refreshStatus(): Promise<void> {
  if (!standalone) {
    try {
      const data = await api('/api/status');
      if (data && data.ok) {
        render(data);
        setLive(true);
        return;
      }
      setLive(false, data && data.error ? String(data.error) : 'offline');
      return;
    } catch {
      // No local API — fall through to the hosted, indexer-only mode.
    }
    if (!(await enterStandalone())) {
      setLive(false, 'API offline — start backend: npm run api');
      return;
    }
  }
  try {
    const lace = await loadLace();
    const data = await lace.readPublicStatus(electionCfg!);
    if (data.ok) {
      render(data);
      setLive(true);
    } else {
      setLive(false, String(data.error ?? 'no contract state'));
    }
  } catch (err) {
    setLive(false, 'indexer unreachable');
    addLog('bad', '❌ Could not read the election from the public indexer: ' + esc(errorMessage(err)));
  }
}

/** Switch to hosted mode if the site ships a public election config (web/public/election.json). */
async function enterStandalone(): Promise<boolean> {
  try {
    const res = await fetch('/election.json', { cache: 'no-store' });
    if (!res.ok) return false;
    electionCfg = await res.json();
  } catch {
    return false;
  }
  if (!electionCfg?.contractAddress || !electionCfg.indexer) return false;
  standalone = true;
  zkConfigBase = window.location.origin + '/zkconfig/private-election';
  setVoteMode('wallet');
  startPolling();
  addLog(
    'info',
    'Hosted demo: reading the <strong>' + esc(electionCfg.network) + '</strong> election straight from the public indexer. ' +
      'To vote, connect <strong>Lace</strong> (set to ' + esc(networkName(electionCfg.network)) + ') — the proof is built in your browser.',
  );
  return true;
}

function setLive(ok: boolean, msg?: string): void {
  const chip = $('liveChip');
  if (!chip) return;
  chip.textContent = ok ? 'live' : (msg || 'offline').slice(0, 28);
  chip.classList.toggle('chip-ok', ok);
  chip.classList.toggle('chip-warn', !ok);
}

// ---------- render ----------

function render(s: { [key: string]: unknown }): void {
  state = s;

  const n = $('networkChip');
  if (n) n.textContent = String(s.network ?? '');

  const c = $('contractChip');
  if (c) {
    c.textContent = shortAddr(String(s.contractAddress ?? ''));
    c.title = String(s.contractAddress ?? '');
  }

  const q = $('question');
  if (q) q.textContent = String(s.question ?? '');

  const pill = $('statePill');
  if (pill) {
    const open = s.state === 0;
    pill.textContent = open ? 'OPEN' : String(s.stateLabel ?? '');
    pill.classList.toggle('open', open);
    pill.classList.toggle('closed', !open);
  }

  const auth = $('authority');
  if (auth) auth.textContent = String(s.authority ?? '');

  const total = $('totalBallots');
  const ballots = Number(s.ballots ?? 0);
  if (total) total.textContent = ballots + (ballots === 1 ? ' ballot' : ' ballots');

  // Balance panel shows the authority wallet via the API; wire map unchanged.
  const f = $('forNum');
  const a = $('againstNum');
  const forV = Number(s.for ?? 0);
  const againstV = Number(s.against ?? 0);
  if (f) f.textContent = String(forV);
  if (a) a.textContent = String(againstV);

  const totalVotes = forV + againstV;
  const fPct = totalVotes > 0 ? Math.round((forV / totalVotes) * 100) : 0;
  const aPct = totalVotes > 0 ? Math.round((againstV / totalVotes) * 100) : 0;
  const fb = $('forBar');
  const ab = $('againstBar');
  if (fb) fb.style.width = (totalVotes > 0 ? fPct : 0) + '%';
  if (ab) ab.style.width = (totalVotes > 0 ? aPct : 0) + '%';

  const audit = $('audit');
  if (audit) {
    audit.classList.toggle('ok', !!s.auditOk);
    audit.classList.toggle('bad', !s.auditOk);
    audit.innerHTML =
      '<span class="audit-icon">' + (s.auditOk ? '✅' : '❌') + '</span>' +
      '<span>ballots (' + ballots + ') == for (' + forV + ') + against (' + againstV +
      ')? <strong>' +
      (s.auditOk ? 'yes — tally is verifiable' : 'no — somebody is cheating!') +
      '</strong></span>';
  }

  const open = s.state === 0;
  if (!busy) {
    const vf = $('voteFor') as HTMLButtonElement | null;
    const va = $('voteAgainst') as HTMLButtonElement | null;
    const cb = $('closeBtn') as HTMLButtonElement | null;
    if (vf) vf.disabled = !open;
    if (va) va.disabled = !open;
    if (cb) cb.disabled = !open;
    if (open) syncVotingHint();
  }
}

// ---------- wallet (Lace) ----------

function refreshWalletPicker(): void {
  const pick = $('walletPick') as HTMLSelectElement | null;
  if (!pick) return;
  const wallets = listWallets();
  pick.textContent = '';
  for (const w of wallets) {
    const opt = document.createElement('option');
    opt.textContent = w.name;
    pick.appendChild(opt);
  }
  pick.hidden = wallets.length <= 1;
  // Keep the Connect button enabled even when no wallet is found, so a click
  // always produces a toast explaining what is missing instead of dead air.
  const btn = $('walletConnect') as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
  if (!session) {
    const status = $('walletStatus');
    if (status) {
      status.textContent = wallets.length > 0
        ? wallets.map((w) => w.name).join(', ') + ' detected'
        : hasOnlyLegacyWallet() ? 'Lace outdated' : 'no wallet found';
    }
  }
}

async function connectWalletFlow(): Promise<void> {
  const btn = $('walletConnect') as HTMLButtonElement | null;
  if (!btn) return;
  if (busy) {
    addLog('bad', '⏳ Ignored connect — an operation is still running. Wait for it to finish (the overlay auto-releases after 3 min).');
    toast('Still busy — wait for the current operation to finish.', true);
    return;
  }
  const wallets = await waitForWallets(1500);
  refreshWalletPicker();
  if (wallets.length === 0) {
    if (hasOnlyLegacyWallet()) {
      toast('Your Lace is too old — update the Midnight Lace extension (needs DApp Connector API v4).', true);
      addLog('bad', '❌ Found only a legacy wallet API on <code>window.midnight</code> (e.g. <code>mnLace.enable()</code>). ' +
        'This app uses ledger v8 / midnight-js 4, which needs a Lace build with DApp Connector API v4 (<code>connect(networkId)</code>).');
    } else {
      toast('No Midnight wallet found — install & unlock the Midnight Lace wallet, then refresh.', true);
      addLog('bad', '❌ No Midnight wallet found on <code>window.midnight</code>. Install the Lace (Midnight) wallet extension, ' +
        'enable it for this site, and reload the page.');
    }
    return;
  }

  const pick = $('walletPick') as HTMLSelectElement | null;
  const selectedIndex = pick && pick.options.length > 0 ? Math.min(pick.selectedIndex, wallets.length - 1) : 0;
  const target = wallets[selectedIndex];
  const networkId = String((state as { network?: string })?.network ?? 'undeployed');

  btn.disabled = true;
  btn.textContent = 'connecting…';
  addLog('info', 'Connecting <strong>' + esc(target.name) + '</strong> (API ' + esc(target.apiVersion ?? '?') + ') to <strong>' +
    esc(networkName(networkId)) + '</strong> (<code>' + esc(networkId) + '</code>) — approve the request in the Lace popup…');
  try {
    wallet = target;
    session = await withTimeout(connectWallet(target, networkId), WALLET_CONNECT_TIMEOUT_MS, 'Wallet connect');
    if (session.config.networkId !== networkId) {
      addLog(
        'warn',
        '⚠️ Lace is on network <strong>' + esc(session.config.networkId) + '</strong>, app is on <strong>' +
          esc(networkId) + '</strong>. If votes hang, switch the vote mode to Backend.',
      );
    }
    providers = null;
    const connected = session;
    const bal = await loadLace()
      .then((m) => withTimeout(m.readWalletBalances(connected.api), 30_000, 'Reading balances'))
      .catch((err) => {
        addLog('warn', '⚠️ Could not read wallet balances: ' + esc(errorMessage(err)));
        return null;
      });

    const status = $('walletStatus');
    if (status) status.textContent = 'connected';
    const addr = $('walletAddr');
    if (addr) { addr.textContent = shortAddr(session.unshieldedAddress); addr.title = session.unshieldedAddress; }
    const net = $('walletNetwork');
    if (net) net.textContent = session.config.networkId + (session.config.networkId !== networkId ? ' (app expects ' + networkId + ')' : '');
    const night = $('walletNight');
    if (night) night.textContent = bal ? Number(bal.tNight).toLocaleString() : 'n/a';
    const dust = $('walletDust');
    if (dust) dust.textContent = bal ? Number(bal.dust).toLocaleString() + ' (cap ' + Number(bal.dustCap).toLocaleString() + ')' : 'n/a';
    const indexer = $('walletIndexer');
    if (indexer) { indexer.textContent = session.config.indexerUri; indexer.title = session.config.indexerUri; }
    const proof = $('walletProof');
    if (proof) proof.textContent = session.config.proverServerUri ?? 'built-in provider / fallback';

    const note = $('walletNote');
    if (note) {
      note.textContent = 'Voting now runs as a browser circuit call: Lace holds the keys and signs the transaction. ' +
        (bal && BigInt(bal.dust) > 0n
          ? 'DUST available — fee-paying is possible.'
          : 'The wallet reports 0 DUST; fee-paying may fail until the account is funded.');
    }

    const details = $('walletDetails');
    if (details) details.hidden = false;

    $('walletConnect')!.textContent = 'Disconnect';
    if (state && (state as { state?: number }).state === 0) syncVotingHint();

    addLog('good', '✅ Wallet connected — ' + esc(session.unshieldedAddress));
    toast('Lace connected. Casting a ballot now proves it in-browser.');
  } catch (err) {
    wallet = null;
    session = null;
    const msg = describeConnectorError(err, networkId) ?? errorMessage(err);
    addLog('bad', '❌ Wallet connect failed: ' + esc(msg));
    addLog('info', 'Checklist: Lace unlocked · Lace → Settings → Midnight network set to <strong>' + esc(networkId) +
      '</strong>' + (networkId === 'undeployed'
        ? ' (local devnet: indexer <code>http://127.0.0.1:8088</code>, node <code>ws://127.0.0.1:9944</code>, ' +
          'proof server <code>http://127.0.0.1:6300</code>)'
        : '') + ' · this site allowed.');
    toast('Wallet connect failed: ' + msg, true);
  } finally {
    btn.disabled = false;
    btn.textContent = session ? 'Disconnect' : 'Connect Lace';
  }
}

function disconnectWallet(): void {
  wallet = null;
  session = null;
  providers = null;
  const details = $('walletDetails');
  if (details) details.hidden = true;
  const status = $('walletStatus');
  if (status) status.textContent = 'not connected';
  const btn = $('walletConnect') as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.textContent = 'Connect Lace'; }
  syncVotingHint();
  addLog('info', 'Wallet disconnected — votes will use the backend proof server.');
  refreshWalletPicker();
}

// ---------- actions ----------

function startBusy(title: string, mode: 'backend' | 'wallet' = 'backend'): void {
  busy = true;
  busyStart = Date.now();
  const vf = $('voteFor') as HTMLButtonElement | null;
  const va = $('voteAgainst') as HTMLButtonElement | null;
  const cb = $('closeBtn') as HTMLButtonElement | null;
  if (vf) vf.disabled = true;
  if (va) va.disabled = true;
  if (cb) cb.disabled = true;

  const b = $('busy');
  if (b) b.hidden = false;
  const t = $('busyTitle');
  if (t) t.textContent = title;
  if (pollTimer) clearInterval(pollTimer);

  const walletMode = mode === 'wallet';
  const noticeAt = walletMode ? 20_000 : STUCK_NOTICE_AT_MS;

  let noticed = false;
  let toasted = false;
  busyTicker = window.setInterval(() => {
    const elapsed = Date.now() - busyStart;
    const s = Math.round(elapsed / 1000);
    const sub = $('busySub');
    if (sub) {
      sub.textContent = walletMode
        ? 'Proving + signing inside Lace (' + s + 's elapsed). Needs a synced wallet — if it hangs, the wallet cannot sync with the indexer; switch to Backend mode.'
        : 'Generating the proof on the backend proof server (' + s + 's elapsed). Your identity stays hidden.';
    }

    if (elapsed >= noticeAt && !noticed) {
      noticed = true;
      if (walletMode) {
        addLog(
          'bad',
          `⚠️ Lace proving still running after ${Math.round(noticeAt / 1000)}s. If the console shows <code>Wallet.Sync</code> errors, the wallet cannot reach the indexer. ` +
            '<strong>Switch to Backend mode</strong> — the backend proof server completes in ~20s.',
        );
      } else {
        addLog(
          'bad',
          `⚠️ Still waiting after ${Math.round(noticeAt / 1000)}s. If the console shows <code>Wallet.Sync</code> errors, the backend wallet cannot sync with the indexer.`,
        );
      }
    }
    if (elapsed >= STUCK_TOAST_AT_MS && !toasted) {
      toasted = true;
      toast(
        walletMode
          ? 'Lace is stuck (likely a wallet↔indexer sync problem). Switch to Backend mode for a reliable ~20s vote.'
          : 'This is taking unusually long — likely a backend wallet↔indexer sync problem.',
        true,
      );
    }
  }, 1000);
}

function stopBusy(): void {
  busy = false;
  const b = $('busy');
  if (b) b.hidden = true;
  if (busyTicker) clearInterval(busyTicker);
  startPolling();
  void refreshStatus();
}

async function castVoteWithWallet(choice: string): Promise<void> {
  if (!session || !wallet) throw new Error('No wallet session');
  if (!state || !state.contractAddress) throw new Error('No contract address — wait for the status to load first');

  addLog('info', 'Loading the Midnight SDK in the browser (first time only)…');
  const lace = await loadLace();

  if (!providers) {
    const built = await lace.buildBrowserProviders(session, {
      zkConfigBaseURL: zkConfigBase,
      indexerFallback: String((state as { indexer?: string }).indexer ?? ''),
      indexerWsFallback: String((state as { indexerWS?: string }).indexerWS ?? ''),
      proofServerFallback: String((state as { proofServer?: string }).proofServer ?? ''),
    });
    providers = built.providers;
    addLog('info', 'Providers ready — proving via <code>' + esc(built.provingVia) + '</code>.');
  }

  const res = await lace.castVoteViaLace(
    providers,
    String(state.contractAddress),
    choice === 'for',
    (msg) => addLog('info', msg),
  );

  addLog(
    'good',
    '✅ Ballot <strong>' + esc(choice.toUpperCase()) + '</strong> cast via Lace.<br>' +
      'tx <code>' + esc(res.txId) + '</code><br>' +
      'ballot id <code>0x' + esc(res.ballotId) + '</code><br>' +
      'matches local prediction? <strong>' + (res.matched ? 'yes — proof opened the predicted secret' : 'no') + '</strong>',
  );
  toast(res.matched ? 'Ballot cast — the nullifier matches the local secret. Your choice is private.' : 'Ballot cast — but the nullifier did not match the predicted secret.');
}

async function castVote(choice: string): Promise<void> {
  if (busy || !state || (state as { state?: number }).state !== 0) return;
  const useWallet = voteMode === 'wallet' && !!session;

  if (standalone && !useWallet) {
    addLog('bad', '❌ The hosted demo has no backend. Click <strong>Connect Lace</strong> (Preprod) to vote from your browser.');
    toast('Connect Lace to vote on the hosted demo.', true);
    return;
  }

  if (voteMode === 'wallet' && !session) {
    addLog(
      'bad',
      '❌ Via Lace selected but no wallet is connected. Connect the wallet first, or switch to <strong>Backend (recommended)</strong> mode.',
    );
    toast('Lace is not connected — switch to Backend mode or connect the wallet first.', true);
    return;
  }

  startBusy(
    useWallet
      ? 'Casting a ' + choice.toUpperCase() + ' ballot via Lace…'
      : 'Casting a ' + choice.toUpperCase() + ' ballot (backend proof server)…',
    useWallet ? 'wallet' : 'backend',
  );
  addLog(
    'info',
    'Casting <strong>' + choice.toUpperCase() + '</strong> ballot as a new anonymous voter via ' +
      esc(useWallet ? 'Lace (in-browser)' : 'the backend proof server') + '…',
  );
  try {
    if (useWallet) {
      await withTimeout(castVoteWithWallet(choice), WALLET_VOTE_TIMEOUT_MS, 'In-browser vote (Lace)');
    } else {
      const data = await withTimeout(
        api('/api/vote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ choice }),
        }),
        BUSY_HARD_TIMEOUT_MS,
        'Backend vote',
      );
      if (data && data.ok) {
        addLog(
          'good',
          '✅ Ballot <strong>' + esc(choice.toUpperCase()) + '</strong> cast.<br>' +
            'tx <code>' + esc(data.txId) + '</code><br>' +
            'ballot id <code>' + esc(data.ballotId) + '</code>',
        );
        toast('Ballot cast — the choice is private, only the nullifier is public.');
      } else {
        addLog('bad', '❌ Vote failed: ' + esc((data && String(data.error)) || 'unknown error'));
        toast(String((data && data.error) || 'Vote failed'), true);
      }
    }
  } catch (err) {
    const msg = describeConnectorError(err, session?.networkId ?? 'undeployed') ?? errorMessage(err);
    if (useWallet) providers = null; // rebuild providers on the next attempt
    addLog('bad', '❌ Vote failed: ' + esc(msg));
    toast('Vote failed: ' + msg, true);
    if (String(msg).includes('prover') || String(msg).includes('proof server')) {
      addLog('info', 'The browser path needs a proof server. Connect Lace to a network with one, or vote via the backend by disconnecting.');
    }
    if (String(msg).includes('Wallet.')) {
      addLog('info', 'The wallet reported a sync/transaction failure. If <code>Wallet.Sync</code> persists, disconnect and vote via the backend.');
    }
  } finally {
    stopBusy();
  }
}

async function closeElection(): Promise<void> {
  if (busy || !state || (state as { state?: number }).state !== 0) return;
  if (standalone) {
    addLog('info', 'Closing needs the election authority\'s admin secret, which never leaves the deployer\'s machine. ' +
      'The authority closes it with <code>npm run cli</code> → option 4.');
    toast('Only the election authority can close it (from the CLI).', true);
    return;
  }
  if (!window.confirm('Close this election? The authority cannot reopen it.')) return;
  startBusy('Closing the election…', 'backend');
  addLog('info', 'Closing the election (requires the authority admin secret — held by the backend)…');
  try {
    const data = await withTimeout(api('/api/close', { method: 'POST' }), BUSY_HARD_TIMEOUT_MS, 'Close');
    if (data && data.ok) {
      addLog('good', '✅ Election CLOSED. tx <code>' + esc(data.txId) + '</code>');
      toast('Election closed. The tally is final.');
    } else {
      addLog('bad', '❌ Close failed: ' + esc((data && String(data.error)) || 'unknown error'));
      toast(String((data && data.error) || 'Close failed'), true);
    }
  } catch (err) {
    addLog('bad', '❌ Close failed: ' + esc(errorMessage(err)));
    toast('Close failed: ' + errorMessage(err), true);
  } finally {
    stopBusy();
  }
}

async function checkBalance(): Promise<void> {
  const btn = $('balanceBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'syncing…'; }
  try {
    const data = await api('/api/balance');
    if (data && data.ok) {
      $('balanceAddr')!.textContent = shortAddr(String(data.address));
      $('balanceAddr')!.title = String(data.address);
      $('nightBal')!.textContent = Number(data.tNight).toLocaleString();
      $('dustBal')!.textContent = Number(data.dust).toLocaleString();
      addLog('info', 'Balance checked — ' + Number(data.tNight).toLocaleString() + ' tNIGHT, ' + Number(data.dust).toLocaleString() + ' DUST.');
    } else {
      addLog('bad', '❌ Balance failed: ' + esc((data && String(data.error)) || 'unknown error'));
    }
  } catch (err) {
    addLog('bad', '❌ Balance failed: ' + esc(err instanceof Error ? err.message : err));
  }
  if (btn) { btn.disabled = false; btn.textContent = 'check'; }
}

// ---------- polling ----------

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  // The public indexer is shared — poll it gently in hosted mode.
  pollTimer = window.setInterval(() => void refreshStatus(), standalone ? 15000 : 4000);
}

// ---------- boot ----------

function boot(): void {
  if (!$('question')) return; // landing page

  const vf = $('voteFor');
  const va = $('voteAgainst');
  const cb = $('closeBtn');
  const rb = $('refreshBtn');
  const bb = $('balanceBtn');
  const wc = $('walletConnect');

  if (vf) vf.addEventListener('click', () => void castVote('for'));
  if (va) va.addEventListener('click', () => void castVote('against'));
  if (cb) cb.addEventListener('click', () => void closeElection());
  if (rb) rb.addEventListener('click', () => { void refreshStatus(); toast('Status refreshed.'); });
  if (bb) bb.addEventListener('click', () => void checkBalance());

  if (wc) {
    wc.addEventListener('click', () => {
      if (session) disconnectWallet();
      else void connectWalletFlow();
    });
  }

  addLog('info', 'Connected to the local Midnight devnet. The dashboard polls the public ledger every 4s.');
  addLog('info', 'Tip: connect the Lace wallet to cast ballots as an in-browser circuit call.');
  wireVoteMode();
  refreshWalletPicker();
  // Lace injects `window.midnight` from a content script, possibly after we
  // boot — refresh the picker once it shows up.
  void waitForWallets(5000).then(() => refreshWalletPicker());
  void refreshStatus();
  startPolling();
}

// Module scripts can finish evaluating after DOMContentLoaded has fired, so
// never rely on the event alone.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}