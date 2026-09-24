/* PearPass dashboard logic — polls /api/status and talks to the local API. */
(function () {
  'use strict';

  var state = null;
  var busy = false;
  var pollTimer = null;
  var busyStart = 0;
  var busyTicker = null;

  // ---------- tiny helpers ----------
  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(d) {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function addLog(kind, html) {
    var log = $('log');
    if (!log) return;
    var li = document.createElement('li');
    li.className = kind;
    li.innerHTML = '<span class="time">' + fmtTime(Date.now()) + '</span>' + html;
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 40) log.removeChild(log.lastChild);
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 5000);
  }

  function shortAddr(addr) {
    if (!addr) return '—';
    return addr.length > 22 ? addr.slice(0, 10) + '…' + addr.slice(-6) : addr;
  }

  // ---------- api ----------
  // Backend API base URL (port 3001, CORS-enabled). Override with
  // window.PEARPASS_API_URL if the API runs elsewhere.
  var API_BASE = window.PEARPASS_API_URL || 'http://localhost:3001';

  async function api(path, options) {
    var res = await fetch(API_BASE + path, options);
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: 'Invalid response from server' };
    }
    return data;
  }

  async function refreshStatus() {
    try {
      var data = await api('/api/status');
      if (data && data.ok) {
        render(data);
        setLive(true);
      } else {
        setLive(false, data && data.error ? data.error : 'offline');
      }
    } catch (e) {
      setLive(false, 'API offline — start backend: npm run api');
    }
  }

  function setLive(ok, msg) {
    var chip = $('liveChip');
    if (!chip) return;
    chip.textContent = ok ? 'live' : (msg || 'offline').slice(0, 28);
    chip.classList.toggle('chip-ok', ok);
    chip.classList.toggle('chip-warn', !ok);
  }

  // ---------- render ----------
  function render(s) {
    state = s;

    var n = $('networkChip');
    if (n) n.textContent = s.network;

    var c = $('contractChip');
    if (c) {
      c.textContent = shortAddr(s.contractAddress);
      c.title = s.contractAddress;
    }

    var q = $('question');
    if (q) q.textContent = s.question;

    var pill = $('statePill');
    if (pill) {
      var open = s.state === 0;
      pill.textContent = open ? 'OPEN' : s.stateLabel;
      pill.classList.toggle('open', open);
      pill.classList.toggle('closed', !open);
    }

    var auth = $('authority');
    if (auth) auth.textContent = s.authority;

    var total = $('totalBallots');
    if (total) total.textContent = s.ballots + (s.ballots === 1 ? ' ballot' : ' ballots');

    var f = $('forNum');
    var a = $('againstNum');
    if (f) f.textContent = s.for;
    if (a) a.textContent = s.against;

    var totalVotes = s.for + s.against;
    var fPct = totalVotes > 0 ? Math.round((s.for / totalVotes) * 100) : 0;
    var aPct = totalVotes > 0 ? Math.round((s.against / totalVotes) * 100) : 0;
    var fb = $('forBar');
    var ab = $('againstBar');
    if (fb) fb.style.width = (totalVotes > 0 ? fPct : 0) + '%';
    if (ab) ab.style.width = (totalVotes > 0 ? aPct : 0) + '%';

    var audit = $('audit');
    if (audit) {
      audit.classList.toggle('ok', s.auditOk);
      audit.classList.toggle('bad', !s.auditOk);
      audit.innerHTML =
        '<span class="audit-icon">' + (s.auditOk ? '✅' : '❌') + '</span>' +
        '<span>ballots (' +
        s.ballots +
        ') == for (' +
        s.for +
        ') + against (' +
        s.against +
        ')? <strong>' +
        (s.auditOk ? 'yes — tally is verifiable' : 'no — somebody is cheating!') +
        '</strong></span>';
    }

    // voting is only allowed while open and while not busy
    var open = s.state === 0;
    if (!busy) {
      var vf = $('voteFor');
      var va = $('voteAgainst');
      var cb = $('closeBtn');
      if (vf) vf.disabled = !open;
      if (va) va.disabled = !open;
      if (cb) cb.disabled = !open;
    }
  }

  // ---------- actions ----------
  function startBusy(title) {
    busy = true;
    busyStart = Date.now();
    var vf = $('voteFor');
    var va = $('voteAgainst');
    var cb = $('closeBtn');
    if (vf) vf.disabled = true;
    if (va) va.disabled = true;
    if (cb) cb.disabled = true;

    var b = $('busy');
    if (b) b.hidden = false;
    var t = $('busyTitle');
    if (t) t.textContent = title;
    if (pollTimer) clearInterval(pollTimer);
    busyTicker = setInterval(function () {
      var s = Math.round((Date.now() - busyStart) / 1000);
      var sub = $('busySub');
      if (sub)
        sub.textContent =
          'Proof generation + submission can take 30–60s (' +
          s +
          's elapsed). Your identity stays hidden.';
    }, 1000);
  }

  function stopBusy() {
    busy = false;
    var b = $('busy');
    if (b) b.hidden = true;
    if (busyTicker) clearInterval(busyTicker);
    startPolling();
    refreshStatus();
  }

  async function castVote(choice) {
    if (busy) return;
    startBusy('Casting a ' + choice.toUpperCase() + ' ballot…');
    addLog(
      'info',
      'Casting <strong>' + choice.toUpperCase() + '</strong> ballot as a new anonymous voter…',
    );
    try {
      var data = await api('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: choice }),
      });
      if (data && data.ok) {
        addLog(
          'good',
          '✅ Ballot <strong>' + esc(choice.toUpperCase()) + '</strong> cast.<br>' +
            'tx <code>' + esc(data.txId) + '</code><br>' +
            'ballot id <code>' + esc(data.ballotId) + '</code>',
        );
        toast('Ballot cast — the choice is private, only the nullifier is public.');
      } else {
        addLog('bad', '❌ Vote failed: ' + esc((data && data.error) || 'unknown error'));
        toast((data && data.error) || 'Vote failed', true);
      }
    } catch (e) {
      addLog('bad', '❌ Vote failed: ' + esc(e.message || e));
      toast('Vote failed: ' + (e.message || e), true);
    }
    stopBusy();
  }

  async function closeElection() {
    if (busy || !state || state.state !== 0) return;
    if (!window.confirm('Close this election? The authority cannot reopen it.')) return;
    startBusy('Closing the election…');
    addLog('info', 'Closing the election (requires the authority admin secret)…');
    try {
      var data = await api('/api/close', { method: 'POST' });
      if (data && data.ok) {
        addLog('good', '✅ Election CLOSED. tx <code>' + esc(data.txId) + '</code>');
        toast('Election closed. The tally is final.');
      } else {
        addLog('bad', '❌ Close failed: ' + esc((data && data.error) || 'unknown error'));
        toast((data && data.error) || 'Close failed', true);
      }
    } catch (e) {
      addLog('bad', '❌ Close failed: ' + esc(e.message || e));
      toast('Close failed: ' + (e.message || e), true);
    }
    stopBusy();
  }

  async function checkBalance() {
    var btn = $('balanceBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'syncing…';
    }
    try {
      var data = await api('/api/balance');
      if (data && data.ok) {
        $('balanceAddr').textContent = shortAddr(data.address);
        $('balanceAddr').title = data.address;
        $('nightBal').textContent = Number(data.tNight).toLocaleString();
        $('dustBal').textContent = Number(data.dust).toLocaleString();
        addLog('info', 'Balance checked — ' + Number(data.tNight).toLocaleString() + ' tNIGHT, ' + Number(data.dust).toLocaleString() + ' DUST.');
      } else {
        addLog('bad', '❌ Balance failed: ' + esc((data && data.error) || 'unknown error'));
      }
    } catch (e) {
      addLog('bad', '❌ Balance failed: ' + esc(e.message || e));
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'check';
    }
  }

  // ---------- polling ----------
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshStatus, 4000);
  }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    if (!$('question')) return; // landing page

    var vf = $('voteFor');
    var va = $('voteAgainst');
    var cb = $('closeBtn');
    var rb = $('refreshBtn');
    var bb = $('balanceBtn');

    if (vf) vf.addEventListener('click', function () { castVote('for'); });
    if (va) va.addEventListener('click', function () { castVote('against'); });
    if (cb) cb.addEventListener('click', closeElection);
    if (rb) rb.addEventListener('click', function () { refreshStatus(); toast('Status refreshed.'); });
    if (bb) bb.addEventListener('click', checkBalance);

    addLog('info', 'Connected to the local Midnight devnet. The dashboard polls the public ledger every 4s.');
    refreshStatus();
    startPolling();
  });
})();