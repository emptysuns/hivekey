/* hivekey — admin dashboard (vanilla JS SPA) */
'use strict';

/* ============================================================
 * Helpers
 * ============================================================ */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const cssEsc = (window.CSS && CSS.escape)
  ? CSS.escape
  : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

// Escape any server-provided string before it goes into HTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtNum(n) {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a < 10000) return n.toLocaleString('en-US');
  if (a < 1e6) return (n / 1e3).toFixed(1) + 'K';
  if (a < 1e9) return (n / 1e6).toFixed(1) + 'M';
  return (n / 1e9).toFixed(1) + 'B';
}

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '–';
  ms = Number(ms);
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' m';
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : '–';
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : '–';
}

function fmtAgo(ts) {
  if (!ts) return t('never');
  const d = Date.now() - ts;
  if (d < 5000) return t('just now');
  if (d < 60000) return t('{n}s ago', { n: Math.floor(d / 1000) });
  if (d < 3600000) return t('{n}m ago', { n: Math.floor(d / 60000) });
  if (d < 86400000) return t('{n}h ago', { n: Math.floor(d / 3600000) });
  return new Date(ts).toLocaleDateString();
}

function fmtUptime(ms) {
  if (!ms) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
}

function pct(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) + '%' : '–';
}

/* ============================================================
 * Store
 * ============================================================ */

const ROUTES = ['dashboard', 'channels', 'tokens', 'logs', 'settings'];

const store = {
  auth: { username: null, token: null },
  route: 'dashboard',
  overview: null,
  channels: [],
  keysByChannel: {},        // channelId -> [Key]
  revealKeys: {},           // channelId -> bool
  expandedChannel: null,
  selectedKeys: new Set(),
  channelFilter: '',
  channelTest: {},          // channelId -> {state, ok, statusCode, latencyMs, error}
  tokens: [],
  logs: [],
  expandedLogs: new Set(),
  logFilters: { q: '', channelId: '', status: '', limit: 100 },
  live: new Map(),          // id -> live entry
  recent: [],               // latest finished requests (dashboard)
  settings: null,
  sse: { es: null, connected: false, retryMs: 1000, timer: null },
  dashTimer: null,
};

/* ============================================================
 * API helper
 * ============================================================ */

async function api(path, opts) {
  opts = opts || {};
  const init = {
    method: opts.method || 'GET',
    headers: {},
    credentials: 'same-origin',
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (store.auth.token) {
    init.headers['Authorization'] = 'Bearer ' + store.auth.token;
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error(t('Network error. Is the server running?'));
  }

  if (res.status === 401 && !opts.noAuthHandler) onUnauthorized();

  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch (e) { /* non-JSON body */ }

  if (!res.ok) {
    throw new Error((data && data.error) || (res.status + ' ' + res.statusText));
  }
  return data;
}

/* ============================================================
 * Toasts
 * ============================================================ */

function toast(msg, type) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.textContent = t(msg); // untranslated keys and server errors get localized; pre-translated strings pass through
  el.addEventListener('click', () => el.remove());
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

/* ============================================================
 * Modal
 * ============================================================ */

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="modal-close"></div>' +
    '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  root.classList.remove('hidden');
  const first = root.querySelector('input, select, textarea');
  if (first) first.focus();
}

function closeModal() {
  const root = $('#modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
  modelSel = null; // drop channel-modal selector state
}

/* ============================================================
 * Auth
 * ============================================================ */

async function boot() {
  try {
    const me = await api('/api/auth/me', { noAuthHandler: true });
    enterApp(me.username, null); // cookie session; SSE also works via cookie
  } catch (e) {
    showLogin();
  }
}

function enterApp(username, token) {
  store.auth.username = username;
  store.auth.token = token;
  $('#login-view').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#whoami').textContent = username || '';
  connectSSE();
  onRoute();
}

function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  const u = $('#login-username');
  if (u) u.focus();
}

function onUnauthorized() {
  const wasIn = store.auth.username !== null;
  store.auth.username = null;
  store.auth.token = null;
  disconnectSSE();
  clearDashTimer();
  closeModal();
  showLogin();
  if (wasIn) toast('Session expired. Please sign in again.', 'error');
}

async function doLogin(form) {
  const errBox = $('#login-error');
  errBox.classList.add('hidden');
  const btn = $('#login-btn');
  btn.disabled = true;
  try {
    const d = await api('/api/auth/login', {
      method: 'POST',
      noAuthHandler: true,
      body: {
        username: form.elements.username.value,
        password: form.elements.password.value,
      },
    });
    form.reset();
    enterApp(d.username, d.token);
  } catch (e) {
    errBox.textContent = t(e.message);
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST', noAuthHandler: true }); } catch (e) { /* ignore */ }
  store.auth.username = null;
  store.auth.token = null;
  store.overview = null;
  store.live.clear();
  store.recent = [];
  disconnectSSE();
  clearDashTimer();
  showLogin();
}

/* ============================================================
 * SSE
 * ============================================================ */

function connectSSE() {
  disconnectSSE();
  const url = '/api/events' + (store.auth.token ? '?token=' + encodeURIComponent(store.auth.token) : '');
  let es;
  try {
    es = new EventSource(url); // same-origin: session cookie is sent automatically
  } catch (e) {
    scheduleReconnect();
    return;
  }
  store.sse.es = es;

  es.onopen = () => {
    store.sse.connected = true;
    store.sse.retryMs = 1000;
    renderConnStatus();
  };

  es.addEventListener('snapshot', (e) => { safeJson(e, handleSnapshot); });
  es.addEventListener('request', (e) => { safeJson(e, handleRequestEvent); });
  es.addEventListener('keys', (e) => { safeJson(e, handleKeysEvent); });
  es.addEventListener('overview', (e) => { safeJson(e, handleOverviewEvent); });

  es.onerror = () => {
    store.sse.connected = false;
    renderConnStatus();
    es.close();
    if (store.sse.es === es) store.sse.es = null;
    if (store.auth.username !== null) scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (store.sse.timer) clearTimeout(store.sse.timer);
  store.sse.timer = setTimeout(connectSSE, store.sse.retryMs);
  store.sse.retryMs = Math.min(store.sse.retryMs * 2, 30000);
}

function disconnectSSE() {
  if (store.sse.timer) { clearTimeout(store.sse.timer); store.sse.timer = null; }
  if (store.sse.es) { store.sse.es.close(); store.sse.es = null; }
  store.sse.connected = false;
  renderConnStatus();
}

function safeJson(e, fn) {
  try { fn(JSON.parse(e.data)); } catch (err) { /* malformed event — ignore */ }
}

function renderConnStatus() {
  const el = $('#conn-status');
  if (!el) return;
  el.classList.toggle('connected', store.sse.connected);
  el.querySelector('.conn-text').textContent = store.sse.connected ? t('Live') : t('Disconnected');
}

function handleSnapshot(d) {
  if (d.overview) store.overview = d.overview;
  store.live.clear();
  (d.live || []).forEach((en) => { if (en && en.id) store.live.set(en.id, en); });
  if (store.route === 'dashboard') {
    renderDashStats();
    drawHistoryChart();
    renderLiveTable();
  }
}

function handleRequestEvent(d) {
  const entry = d && d.entry;
  if (!entry || !entry.id) return;
  if (d.phase === 'start' || d.phase === 'retry') {
    store.live.set(entry.id, entry);
    if (store.route === 'dashboard') renderLiveTable();
  } else if (d.phase === 'end') {
    store.live.delete(entry.id);
    store.recent.unshift(entry);
    if (store.recent.length > 15) store.recent.length = 15;
    if (store.route === 'dashboard') {
      renderLiveTable();
      renderRecentTable();
    } else if (store.route === 'logs' && logMatchesFilters(entry)) {
      store.logs.unshift(entry);
      const lim = Number(store.logFilters.limit) || 100;
      if (store.logs.length > lim) store.logs.length = lim;
      renderLogsTable();
    }
  }
}

function handleKeysEvent(d) {
  if (!d || !d.keyId) return;
  const list = store.keysByChannel[d.channelId];
  if (list) {
    const k = list.find((x) => x.id === d.keyId);
    if (k) {
      k.status = d.status;
      k.cooldownUntil = d.cooldownUntil;
      if (d.status === 'disabled') k.enabled = false;
    }
  }
  // Patch badges in place (key panel and/or edit modal) — avoids clobbering inputs.
  $$('[data-key-badge="' + cssEsc(d.keyId) + '"]').forEach((badge) => {
    badge.outerHTML = keyBadgeHtml({ id: d.keyId, status: d.status, cooldownUntil: d.cooldownUntil });
  });
}

function handleOverviewEvent(d) {
  if (!d) return;
  // Same shape as /api/overview totals+rpm+keyCounts — merge, keep history.
  store.overview = Object.assign({}, store.overview || {}, d);
  if (store.route === 'dashboard') renderDashStats();
}

/* ============================================================
 * Router
 * ============================================================ */

function onRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const seg = raw.split('/')[0];
  const route = ROUTES.indexOf(seg) >= 0 ? seg : 'dashboard';
  if (seg !== route) { // empty or unknown hash — normalize without history spam
    location.replace('#/' + route);
    return;
  }
  store.route = route;
  clearDashTimer();
  closeModal();
  renderNav();
  if (store.auth.username === null) return; // login view is showing
  switch (route) {
    case 'dashboard': renderDashboard(); break;
    case 'channels': renderChannels(); break;
    case 'tokens': renderTokens(); break;
    case 'logs': renderLogs(); break;
    case 'settings': renderSettings(); break;
  }
}

function renderNav() {
  $$('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === store.route);
  });
}

function clearDashTimer() {
  if (store.dashTimer) { clearInterval(store.dashTimer); store.dashTimer = null; }
}

/* ============================================================
 * Dashboard
 * ============================================================ */

async function renderDashboard() {
  $('#view').innerHTML =
    '<div class="view-head"><h2>' + esc(t('Dashboard')) + '</h2><div class="sub" id="uptime-sub"></div></div>' +
    '<div id="problem-banner"></div>' +
    '<div class="stat-grid" id="stat-cards"></div>' +
    '<div class="card">' +
      '<div class="card-head"><h3>' + esc(t('Requests per minute')) + '</h3>' +
      '<div class="legend">' +
        '<span><span class="sw" style="background:var(--good)"></span>' + esc(t('Success')) + '</span>' +
        '<span><span class="sw" style="background:var(--crit)"></span>' + esc(t('Failed')) + '</span>' +
      '</div></div>' +
      '<div class="chart-wrap"><canvas id="rpm-chart" height="220"></canvas>' +
      '<div class="chart-band hidden" id="chart-band"></div>' +
      '<div class="chart-tip hidden" id="chart-tip"></div></div>' +
    '</div>' +
    '<div class="card flush">' +
      '<div class="card-head"><h3>' + esc(t('Live requests')) + ' <span class="muted small" id="live-count"></span></h3></div>' +
      '<div class="table-scroll"><table>' +
        '<thead><tr><th>' + esc(t('Started')) + '</th><th>' + esc(t('Model')) + '</th><th>' + esc(t('Channel')) + '</th><th>' + esc(t('Key')) + '</th><th class="num">' + esc(t('Attempts')) + '</th><th class="num">' + esc(t('Elapsed')) + '</th></tr></thead>' +
        '<tbody id="live-tbody"></tbody>' +
      '</table></div>' +
    '</div>' +
    '<div class="card flush">' +
      '<div class="card-head"><h3>' + esc(t('Recent requests')) + '</h3></div>' +
      '<div class="table-scroll"><table>' +
        '<thead><tr><th>' + esc(t('Time')) + '</th><th>' + esc(t('Status')) + '</th><th>' + esc(t('Model')) + '</th><th>' + esc(t('Channel')) + '</th><th>' + esc(t('Key')) + '</th><th class="num">' + esc(t('Attempts')) + '</th><th class="num">' + esc(t('Latency')) + '</th></tr></thead>' +
        '<tbody id="recent-tbody"></tbody>' +
      '</table></div>' +
    '</div>';

  renderDashStats();
  drawHistoryChart();
  renderLiveTable();
  renderRecentTable();
  wireChartHover();

  try {
    const [ov, live] = await Promise.all([
      api('/api/overview'),
      api('/api/requests/live'),
    ]);
    store.overview = ov;
    store.live.clear();
    (live || []).forEach((en) => { if (en && en.id) store.live.set(en.id, en); });
    if (store.recent.length === 0) {
      try {
        const seed = await api('/api/logs?limit=15');
        store.recent = seed || [];
      } catch (e) { /* non-fatal */ }
    }
    if (store.route !== 'dashboard') return;
    renderDashStats();
    drawHistoryChart();
    renderLiveTable();
    renderRecentTable();
  } catch (e) {
    if (store.route === 'dashboard') toast(e.message, 'error');
  }

  // Refresh the minute-bucket history periodically; cards update via SSE.
  clearDashTimer();
  store.dashTimer = setInterval(async () => {
    if (store.route !== 'dashboard' || store.auth.username === null) return;
    try {
      store.overview = await api('/api/overview');
      renderDashStats();
      drawHistoryChart();
    } catch (e) { /* transient */ }
  }, 60000);
}

function renderDashStats() {
  const box = $('#stat-cards');
  if (!box) return;
  const ov = store.overview || {};
  const tot = ov.totals || {};
  const kc = ov.keyCounts || {};
  const tokens = (Number(tot.promptTokens) || 0) + (Number(tot.completionTokens) || 0);

  box.innerHTML =
    statTile(t('Total requests'), fmtNum(tot.requests || 0)) +
    statTile(t('Success rate'), pct(tot.success || 0, tot.requests || 0),
      t('{ok} ok / {failed} failed', { ok: fmtNum(tot.success || 0), failed: fmtNum(tot.failed || 0) })) +
    statTile(t('Requests / min'), (ov.rpm != null ? Number(ov.rpm).toFixed(1) : '–')) +
    statTile(t('Avg latency'), fmtMs(ov.avgLatencyMs)) +
    statTile(t('In flight'), fmtNum(tot.inflight || 0), t('{n} retries total', { n: fmtNum(tot.retries || 0) })) +
    statTile(t('Tokens used'), fmtNum(tokens),
      t('{p} prompt / {c} completion', { p: fmtNum(tot.promptTokens || 0), c: fmtNum(tot.completionTokens || 0) })) +
    '<div class="stat stat-keys"><div class="label">' + esc(t('Keys')) + '</div><div class="value">' +
      '<span class="kc ok-text">' + fmtNum(kc.active || 0) + ' <small>' + esc(t('active')) + '</small></span>' +
      '<span class="kc" style="color:var(--warn)">' + fmtNum(kc.cooldown || 0) + ' <small>' + esc(t('cooldown')) + '</small></span>' +
      '<span class="kc muted">' + fmtNum(kc.disabled || 0) + ' <small>' + esc(t('disabled')) + '</small></span>' +
    '</div></div>';

  const up = $('#uptime-sub');
  if (up) {
    up.textContent = t('Uptime {t}', { t: fmtUptime(ov.uptimeMs) }) +
      (ov.channelCount != null ? ' · ' + t('{n} channels', { n: ov.channelCount }) : '');
  }
  renderProblemBanner();
}

function statTile(label, value, sub) {
  return '<div class="stat"><div class="label">' + esc(label) + '</div>' +
    '<div class="value">' + value + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

/* ----- failing-key warning banner ----- */

function renderProblemBanner() {
  const box = $('#problem-banner');
  if (!box) return;
  const list = (store.overview && store.overview.problemKeys) || [];
  if (!list.length) { box.innerHTML = ''; return; }
  const MAX = 6;
  box.innerHTML =
    '<div class="card alert-card">' +
      '<div class="alert-head">' +
        '<span class="alert-icon">⚠</span>' +
        '<strong>' + esc(t('{n} keys need attention', { n: list.length })) + '</strong>' +
        '<span class="muted small">' + esc(t('Reset clears failures and re-enables the key.')) + '</span>' +
        '<span class="spacer"></span>' +
        '<a class="btn btn-sm" href="#/channels">' + esc(t('View channels')) + '</a>' +
      '</div>' +
      '<div class="alert-list">' +
      list.slice(0, MAX).map((p) =>
        '<div class="alert-row">' +
          '<span class="alert-ch" title="' + esc(p.channelName) + '">' + esc(p.channelName) + '</span>' +
          '<span class="mono">' + esc(p.keyMasked) + '</span>' +
          problemReasonBadge(p) +
          '<span class="muted small">' + esc(t('{failed}/{total} failed', { failed: fmtNum(p.failed), total: fmtNum(p.requests) })) + '</span>' +
          (p.lastError ? '<span class="err-cell small" title="' + esc(p.lastError) + '">' + esc(truncate(p.lastError, 60)) + '</span>' : '') +
          '<span class="spacer"></span>' +
          '<button class="btn btn-sm" data-action="problem-key-reset" data-id="' + esc(p.keyId) + '">' + esc(t('Reset')) + '</button>' +
        '</div>'
      ).join('') +
      (list.length > MAX ? '<div class="alert-more muted small">' + esc(t('+{n} more…', { n: list.length - MAX })) + '</div>' : '') +
      '</div>' +
    '</div>';
}

function problemReasonBadge(p) {
  if (p.reason === 'auto_disabled') {
    return '<span class="badge badge-error">' + esc(t('auto-disabled')) + '</span>';
  }
  if (p.reason === 'failing') {
    return '<span class="badge badge-cooldown">' + esc(t('{n} consecutive failures', { n: p.consecutiveFailures })) + '</span>';
  }
  return '<span class="badge badge-error">' + esc(t('{pct} error rate', { pct: pct(p.failed, p.requests) })) + '</span>';
}

/* ----- chart ----- */

let chartGeom = null;

function niceStep(v) {
  v = Math.max(v, 1);
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 5];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] * p >= v) return steps[i] * p;
  }
  return 10 * p;
}

function drawHistoryChart() {
  const canvas = $('#rpm-chart');
  if (!canvas) return;
  const hist = ((store.overview && store.overview.history) || []).slice(-60);
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(wrap.clientWidth || 0, 280);
  const H = 220;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 38, padR = 6, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const baseY = padT + plotH;
  const cGrid = '#2c2c2a', cBase = '#383835', cMuted = '#898781';
  const cGood = '#0ca30c', cCrit = '#d03b3b';
  ctx.font = '11px system-ui, sans-serif';

  const maxV = Math.max(1, ...hist.map((b) =>
    Math.max(Number(b.requests) || 0, (Number(b.success) || 0) + (Number(b.failed) || 0))));
  const step = niceStep(maxV / 4);
  const top = Math.max(step, Math.ceil(maxV / step) * step);
  const yFor = (v) => baseY - (v / top) * plotH;

  // Gridlines + y labels (hairline, recessive)
  for (let v = 0; v <= top; v += step) {
    const y = Math.round(yFor(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? cBase : cGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillStyle = cMuted;
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(v), padL - 6, y + 3.5);
  }

  chartGeom = { slots: [], padT, plotH, padL, W, H };

  if (hist.length === 0) {
    ctx.fillStyle = cMuted;
    ctx.textAlign = 'center';
    ctx.fillText(t('No traffic yet'), padL + plotW / 2, padT + plotH / 2);
    return;
  }

  const n = hist.length;
  const slotW = plotW / n;
  const barW = Math.min(24, Math.max(2, slotW - 2)); // ≤24px thick, ≥2px surface gap between bars
  const r = Math.min(4, barW / 2);

  hist.forEach((b, i) => {
    const x = padL + i * slotW + (slotW - barW) / 2;
    const s = Number(b.success) || 0;
    const f = Number(b.failed) || 0;
    const hs = (s / top) * plotH;
    const hf = (f / top) * plotH;
    let topY = baseY;
    if (s > 0) {
      const y = baseY - hs;
      if (f > 0) {
        ctx.fillStyle = cGood; // interior segment: square ends
        ctx.fillRect(x, y, barW, hs);
      } else {
        fillRoundedTop(ctx, x, y, barW, hs, r, cGood);
      }
      topY = y;
    }
    if (f > 0) {
      const gap = s > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(hf, 1.5);
      fillRoundedTop(ctx, x, topY - gap - h, barW, h, r, cCrit);
    }
    // x labels on quarter hours
    const d = new Date(Number(b.ts) || 0);
    if (b.ts && d.getMinutes() % 15 === 0) {
      ctx.fillStyle = cMuted;
      ctx.textAlign = 'center';
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      ctx.fillText(hh + ':' + mm, x + barW / 2, H - 6);
    }
    chartGeom.slots.push({ x0: padL + i * slotW, x1: padL + (i + 1) * slotW, b });
  });
}

function fillRoundedTop(ctx, x, y, w, h, r, color) {
  if (h <= 0) return;
  const rr = Math.min(r, h);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + h);            // bottom-left (square at baseline)
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);  // rounded data-end
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function wireChartHover() {
  const canvas = $('#rpm-chart');
  const tip = $('#chart-tip');
  const band = $('#chart-band');
  if (!canvas || !tip) return;

  canvas.addEventListener('mousemove', (e) => {
    if (!chartGeom || !chartGeom.slots.length) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const slot = chartGeom.slots.find((s) => mx >= s.x0 && mx < s.x1);
    if (!slot) { tip.classList.add('hidden'); band.classList.add('hidden'); return; }
    const b = slot.b;
    const d = new Date(Number(b.ts) || 0);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    tip.innerHTML =
      '<div class="tip-time">' + hh + ':' + mm + '</div>' +
      '<div>' + esc(t('{n} requests', { n: fmtNum(b.requests || 0) })) + '</div>' +
      '<div><span class="sw" style="background:var(--good);display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></span>' + esc(t('{n} success', { n: fmtNum(b.success || 0) })) + '</div>' +
      '<div><span class="sw" style="background:var(--crit);display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></span>' + esc(t('{n} failed', { n: fmtNum(b.failed || 0) })) + '</div>';
    tip.classList.remove('hidden');
    band.classList.remove('hidden');
    band.style.left = slot.x0 + 'px';
    band.style.width = (slot.x1 - slot.x0) + 'px';
    band.style.top = chartGeom.padT + 'px';
    band.style.height = chartGeom.plotH + 'px';
    const wrapW = canvas.parentElement.clientWidth;
    const tipW = tip.offsetWidth || 120;
    let left = mx + 14;
    if (left + tipW > wrapW - 4) left = mx - tipW - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(0, e.clientY - rect.top - 20) + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    band.classList.add('hidden');
  });
}

/* ----- live + recent tables ----- */

function renderLiveTable() {
  const tbody = $('#live-tbody');
  if (!tbody) return;
  const items = Array.from(store.live.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const count = $('#live-count');
  if (count) count.textContent = items.length ? '(' + items.length + ')' : '';
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">' + esc(t('No requests in flight.')) + '</td></tr>';
    return;
  }
  const now = Date.now();
  tbody.innerHTML = items.map((en) => {
    const elapsed = en.ts ? now - en.ts : (en.elapsedMs || 0);
    return '<tr>' +
      '<td class="muted">' + esc(fmtTime(en.ts)) + '</td>' +
      '<td>' + esc(en.model || '–') + '</td>' +
      '<td>' + esc(en.channelName || '–') + '</td>' +
      '<td class="mono">' + esc(en.keyMasked || '–') + '</td>' +
      '<td class="num">' + esc(en.attempts != null ? en.attempts : 1) + '</td>' +
      '<td class="num" data-elapsed-ts="' + esc(en.ts || '') + '">' + fmtMs(elapsed) + '</td>' +
      '</tr>';
  }).join('');
}

function renderRecentTable() {
  const tbody = $('#recent-tbody');
  if (!tbody) return;
  if (!store.recent.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">' + esc(t('No finished requests yet.')) + '</td></tr>';
    return;
  }
  tbody.innerHTML = store.recent.map((en) => {
    return '<tr>' +
      '<td class="muted">' + esc(fmtTime(en.ts)) + '</td>' +
      '<td>' + statusBadgeHtml(en) + '</td>' +
      '<td>' + esc(en.model || '–') + '</td>' +
      '<td>' + esc(en.channelName || '–') + '</td>' +
      '<td class="mono">' + esc(en.keyMasked || '–') + '</td>' +
      '<td class="num">' + esc(en.attempts != null ? en.attempts : 1) + '</td>' +
      '<td class="num">' + fmtMs(en.latencyMs) + '</td>' +
      '</tr>';
  }).join('');
}

function statusBadgeHtml(en) {
  const ok = en.status === 'success';
  const label = (en.statusCode != null && en.statusCode !== 0)
    ? en.statusCode
    : (ok ? t('ok') : t('error'));
  return '<span class="badge ' + (ok ? 'badge-success' : 'badge-error') + '">' + esc(label) + '</span>';
}

/* ============================================================
 * Channels
 * ============================================================ */

async function renderChannels() {
  $('#view').innerHTML =
    '<div class="view-head"><h2>' + esc(t('Channels')) + '</h2>' +
    '<button class="btn btn-primary" data-action="channel-add">' + esc(t('+ Add channel')) + '</button></div>' +
    '<div class="card table-toolbar">' +
      '<input type="search" data-channel-search placeholder="' + esc(t('Search name, URL or model…')) + '" value="' + esc(store.channelFilter) + '">' +
      '<span class="muted small" id="channel-count"></span>' +
      '<span class="spacer"></span>' +
      '<button class="btn" data-action="channels-refresh">' + esc(t('Refresh')) + '</button>' +
    '</div>' +
    '<div class="card flush"><div class="table-scroll"><table>' +
      '<thead><tr><th>' + esc(t('Name')) + '</th><th>' + esc(t('Models')) + '</th><th class="num">' + esc(t('Priority')) + '</th><th class="num">' + esc(t('Weight')) + '</th>' +
      '<th class="num">' + esc(t('Keys')) + '</th><th>' + esc(t('Requests')) + '</th><th>' + esc(t('Response time')) + '</th><th>' + esc(t('Status')) + '</th><th>' + esc(t('Actions')) + '</th></tr></thead>' +
      '<tbody id="channels-tbody"><tr><td colspan="9" class="empty">' + esc(t('Loading…')) + '</td></tr></tbody>' +
    '</table></div></div>';

  try {
    await loadChannelsData();
    renderChannelsTable();
    if (store.expandedChannel && !store.keysByChannel[store.expandedChannel]) {
      loadKeysAndRender(store.expandedChannel);
    }
  } catch (e) {
    const tbody = $('#channels-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="empty">' + esc(t('Failed to load channels.')) + '</td></tr>';
    toast(e.message, 'error');
  }
}

async function loadChannelsData() {
  store.channels = (await api('/api/channels')) || [];
}

function channelMatchesFilter(ch) {
  const q = store.channelFilter.trim().toLowerCase();
  if (!q) return true;
  return [ch.name, ch.baseUrl, (ch.models || []).join(' ')]
    .some((s) => String(s || '').toLowerCase().indexOf(q) >= 0);
}

function channelModelsHtml(ch) {
  const models = ch.models || [];
  if (!models.length) return '<span class="badge badge-neutral">' + esc(t('All models')) + '</span>';
  const shown = models.slice(0, 2);
  let html = shown.map((m) =>
    '<span class="tag tag-static"><span class="tag-label" title="' + esc(m) + '">' + esc(m) + '</span></span>').join('');
  if (models.length > shown.length) {
    html += '<span class="tag tag-static tag-more" title="' + esc(models.join('\n')) + '">+' + (models.length - shown.length) + '</span>';
  }
  return '<div class="tag-cell">' + html + '</div>';
}

function chTestHtml(chId) {
  const r = store.channelTest[chId];
  if (!r) return '<span class="muted small">–</span>';
  if (r.state === 'testing') return '<span class="muted small">' + esc(t('Testing…')) + '</span>';
  if (r.ok) return '<span class="badge badge-success">' + esc(fmtMs(r.latencyMs)) + '</span>';
  return '<span class="badge badge-error" title="' + esc(r.error || '') + '">' +
    esc((r.statusCode || t('error')) + ' · ' + fmtMs(r.latencyMs)) + '</span>';
}

function renderChannelsTable() {
  const tbody = $('#channels-tbody');
  if (!tbody) return;
  const visible = store.channels.filter(channelMatchesFilter);
  const count = $('#channel-count');
  if (count) count.textContent = t('{shown} / {total} channels', { shown: visible.length, total: store.channels.length });
  if (!store.channels.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">' + esc(t('No channels yet. Add one to start routing requests.')) + '</td></tr>';
    return;
  }
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">' + esc(t('No channels match your search.')) + '</td></tr>';
    return;
  }
  tbody.innerHTML = visible.map((ch) => {
    const s = ch.stats || {};
    const expanded = store.expandedChannel === ch.id;
    let html = '<tr class="row-click' + (expanded ? ' row-expanded' : '') + '" data-channel-row="' + esc(ch.id) + '">' +
      '<td><div class="cell-title">' + esc(ch.name) + '</div>' +
        '<div class="mono small muted cell-sub" title="' + esc(ch.baseUrl) + '">' + esc(ch.baseUrl) + '</div></td>' +
      '<td>' + channelModelsHtml(ch) + '</td>' +
      '<td class="num">' + esc(ch.priority != null ? ch.priority : 0) + '</td>' +
      '<td class="num">' + esc(ch.weight != null ? ch.weight : 1) + '</td>' +
      '<td class="num"><span class="ok-text">' + esc(ch.activeKeyCount != null ? ch.activeKeyCount : '?') + '</span>' +
        '<span class="muted">/' + esc(ch.keyCount != null ? ch.keyCount : '?') + '</span></td>' +
      '<td class="small">' + fmtNum(s.requests || 0) + ' <span class="muted">·</span> ' + pct(s.success || 0, s.requests || 0) +
        ' <span class="muted">· ' + fmtMs(s.avgLatencyMs) + '</span></td>' +
      '<td data-chtest="' + esc(ch.id) + '">' + chTestHtml(ch.id) + '</td>' +
      '<td data-stop><label class="switch"><input type="checkbox" data-toggle="channel" data-id="' + esc(ch.id) + '"' +
        (ch.enabled ? ' checked' : '') + '><span class="sl"></span></label></td>' +
      '<td class="actions" data-stop>' +
        '<button class="btn btn-sm" data-action="channel-test" data-id="' + esc(ch.id) + '">' + esc(t('Test')) + '</button>' +
        '<button class="btn btn-sm" data-action="channel-edit" data-id="' + esc(ch.id) + '">' + esc(t('Edit')) + '</button>' +
        '<button class="btn btn-sm btn-danger" data-action="channel-delete" data-id="' + esc(ch.id) + '">' + esc(t('Delete')) + '</button>' +
      '</td></tr>';
    if (expanded) {
      html += '<tr><td colspan="9" class="nopad">' + keyPanelHtml(ch) + '</td></tr>';
    }
    return html;
  }).join('');
  updateBatchBar();
}

/* ----- key panel ----- */

function keyPanelHtml(ch) {
  const reveal = !!store.revealKeys[ch.id];
  return '<div class="key-panel">' +
    '<div class="key-toolbar">' +
      '<strong>' + esc(t('Keys · {name}', { name: ch.name })) + '</strong>' +
      '<label class="checklab"><input type="checkbox" data-reveal data-id="' + esc(ch.id) + '"' + (reveal ? ' checked' : '') + '> ' + esc(t('Reveal keys')) + '</label>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm btn-danger" data-action="keys-delete-selected" data-id="' + esc(ch.id) + '" disabled>' + esc(t('Delete selected')) + '</button>' +
    '</div>' +
    '<div class="table-scroll"><table>' +
      '<thead><tr>' +
        '<th style="width:28px"><input type="checkbox" data-keysel-all data-id="' + esc(ch.id) + '"></th>' +
        '<th>' + esc(t('Key')) + '</th><th>' + esc(t('Status')) + '</th><th class="num">' + esc(t('Req')) + '</th><th class="num">' + esc(t('OK')) + '</th><th class="num">' + esc(t('Fail')) + '</th>' +
        '<th class="num">429</th><th class="num">' + esc(t('Latency')) + '</th><th>' + esc(t('Last error')) + '</th><th>' + esc(t('Actions')) + '</th>' +
      '</tr></thead>' +
      '<tbody id="keys-tbody-' + esc(ch.id) + '">' + keysRowsHtml(ch.id) + '</tbody>' +
    '</table></div>' +
    '<div class="key-import">' +
      '<textarea id="import-keys-' + esc(ch.id) + '" rows="3" placeholder="sk-...&#10;sk-...&#10;' + esc(t('(one key per line)')) + '"></textarea>' +
      '<div class="side">' +
        '<button class="btn" data-action="keys-import" data-id="' + esc(ch.id) + '">' + esc(t('Import keys')) + '</button>' +
        '<span class="hint" id="import-result-' + esc(ch.id) + '"></span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function keysRowsHtml(chId) {
  const keys = store.keysByChannel[chId];
  if (keys === undefined) {
    return '<tr><td colspan="10" class="empty">' + esc(t('Loading keys…')) + '</td></tr>';
  }
  if (!keys.length) {
    return '<tr><td colspan="10" class="empty">' + esc(t('No keys in this channel. Import some below.')) + '</td></tr>';
  }
  return keys.map((k) => {
    const st = k.stats || {};
    const checked = store.selectedKeys.has(k.id);
    const failWarn = (st.requests || 0) >= 10 && (st.failed || 0) / st.requests >= 0.5;
    return '<tr data-key-row="' + esc(k.id) + '">' +
      '<td data-stop><input type="checkbox" data-keysel="' + esc(k.id) + '" data-ch="' + esc(chId) + '"' + (checked ? ' checked' : '') + '></td>' +
      '<td class="mono">' + esc(k.key) + '</td>' +
      '<td>' + keyBadgeHtml(k) + '</td>' +
      '<td class="num">' + fmtNum(st.requests || 0) + '</td>' +
      '<td class="num">' + fmtNum(st.success || 0) + '</td>' +
      '<td class="num' + (failWarn ? ' err-text' : '') + '"' +
        (failWarn ? ' title="' + esc(t('{pct} error rate', { pct: pct(st.failed, st.requests) })) + '"' : '') + '>' +
        fmtNum(st.failed || 0) + '</td>' +
      '<td class="num">' + fmtNum(st.count429 || 0) + '</td>' +
      '<td class="num">' + fmtMs(st.ewmaLatencyMs) + '</td>' +
      '<td class="err-cell" title="' + esc(st.lastError || '') + '">' + esc(truncate(st.lastError || '', 48)) + '</td>' +
      '<td class="actions" data-stop>' +
        '<button class="btn btn-sm" data-action="key-toggle" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '" data-enabled="' + (k.enabled ? 'false' : 'true') + '">' + esc(k.enabled ? t('Disable') : t('Enable')) + '</button>' +
        '<button class="btn btn-sm" data-action="key-reset" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '">' + esc(t('Reset')) + '</button>' +
        '<button class="btn btn-sm" data-action="key-test" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '">' + esc(t('Test')) + '</button>' +
        '<button class="btn btn-sm btn-danger" data-action="key-delete" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '">' + esc(t('Delete')) + '</button>' +
        '<span class="test-result" data-test-result="' + esc(k.id) + '"></span>' +
      '</td></tr>';
  }).join('');
}

function keyBadgeHtml(k) {
  let cls = 'badge-disabled', label = t('disabled'), attrs = '';
  if (k.status === 'active') { cls = 'badge-active'; label = t('active'); }
  else if (k.status === 'cooldown') {
    cls = 'badge-cooldown';
    const remain = Math.max(0, Math.ceil(((Number(k.cooldownUntil) || 0) - Date.now()) / 1000));
    label = t('cooldown · {n}s', { n: remain });
    attrs = ' data-cooldown-until="' + esc(k.cooldownUntil || 0) + '"';
  }
  return '<span class="badge ' + cls + '" data-key-badge="' + esc(k.id) + '"' + attrs + '>' + esc(label) + '</span>';
}

async function loadKeysAndRender(chId) {
  try {
    const reveal = !!store.revealKeys[chId];
    const keys = await api('/api/channels/' + encodeURIComponent(chId) + '/keys' + (reveal ? '?reveal=1' : ''));
    store.keysByChannel[chId] = keys || [];
    // prune selection to existing keys
    const ids = new Set((keys || []).map((k) => k.id));
    store.selectedKeys.forEach((id) => { if (!ids.has(id)) store.selectedKeys.delete(id); });
  } catch (e) {
    store.keysByChannel[chId] = [];
    toast(e.message, 'error');
  }
  const tbody = document.getElementById('keys-tbody-' + chId);
  if (tbody) tbody.innerHTML = keysRowsHtml(chId);
  updateBatchBar();
}

async function refreshChannelsAndKeys(chId) {
  await loadChannelsData();
  if (chId && store.expandedChannel === chId) {
    const reveal = !!store.revealKeys[chId];
    try {
      store.keysByChannel[chId] = (await api('/api/channels/' + encodeURIComponent(chId) + '/keys' + (reveal ? '?reveal=1' : ''))) || [];
      const ids = new Set(store.keysByChannel[chId].map((k) => k.id));
      store.selectedKeys.forEach((id) => { if (!ids.has(id)) store.selectedKeys.delete(id); });
    } catch (e) { /* keep stale cache */ }
  }
  if (store.route === 'channels') renderChannelsTable();
}

function updateBatchBar() {
  const btn = document.querySelector('[data-action="keys-delete-selected"]');
  if (btn) {
    const n = store.selectedKeys.size;
    btn.disabled = n === 0;
    btn.textContent = n ? t('Delete selected ({n})', { n: n }) : t('Delete selected');
  }
  const all = document.querySelector('[data-keysel-all]');
  if (all) {
    const chId = all.dataset.id;
    const keys = store.keysByChannel[chId] || [];
    all.checked = keys.length > 0 && keys.every((k) => store.selectedKeys.has(k.id));
  }
}

/* ----- channel add/edit modal ----- */

function openChannelModal(ch) {
  const isEdit = !!ch;
  ch = ch || {};
  const mappingJson = ch.modelMapping && Object.keys(ch.modelMapping).length
    ? JSON.stringify(ch.modelMapping, null, 2) : '';
  modelSel = {
    selected: (ch.models || []).slice(),
    options: (ch.models || []).slice().sort((a, b) => a.localeCompare(b)),
    query: '',
    open: false,
  };
  openModal(
    '<h3>' + esc(isEdit ? t('Edit channel') : t('Add channel')) + '</h3>' +
    '<form id="channel-form"' + (isEdit ? ' data-id="' + esc(ch.id) + '"' : '') + '>' +
      '<div class="form-grid">' +
        '<div class="form-section span2">' + esc(t('Basics')) + '</div>' +
        '<div class="field"><label>' + esc(t('Name')) + '</label>' +
          '<input name="name" required value="' + esc(ch.name || '') + '" placeholder="OpenAI main"></div>' +
        '<div class="field"><label>' + esc(t('Base URL')) + '</label>' +
          '<input name="baseUrl" required value="' + esc(ch.baseUrl || '') + '" placeholder="https://api.openai.com"></div>' +
        '<div class="field span2"><label>' + esc(t('Proxy')) + ' <span class="muted">' + esc(t('(optional, e.g. http://127.0.0.1:7890)')) + '</span></label>' +
          '<input name="proxy" value="' + esc(ch.proxy || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('Priority')) + ' <span class="muted">' + esc(t('(higher = preferred)')) + '</span></label>' +
          '<input name="priority" type="number" step="1" value="' + esc(ch.priority != null ? ch.priority : 0) + '"></div>' +
        '<div class="field"><label>' + esc(t('Weight')) + '</label>' +
          '<input name="weight" type="number" step="1" min="0" value="' + esc(ch.weight != null ? ch.weight : 1) + '"></div>' +

        '<div class="form-section span2">' + esc(t('Models')) + ' <span class="muted normalcase">' + esc(t('(empty = serve all models)')) + '</span></div>' +
        '<div class="span2">' +
          '<div class="model-widget" data-model-widget>' +
            '<div class="tag-select" data-model-box></div>' +
            '<div class="tag-dropdown hidden" data-model-dropdown></div>' +
          '</div>' +
          '<div class="fetch-models-row">' +
            '<button type="button" class="btn btn-sm" data-action="fetch-models"' + (isEdit ? ' data-id="' + esc(ch.id) + '"' : '') + '>' + esc(t('Fetch models')) + '</button>' +
            '<button type="button" class="btn btn-sm" data-action="models-clear">' + esc(t('Clear all')) + '</button>' +
            '<span class="hint" id="fetch-models-hint">' + esc(t('Type to add models, or pull /v1/models from the upstream.')) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="field span2"><label>' + esc(t('Model mapping')) + ' <span class="muted">' + esc(t('(JSON, requested → upstream)')) + '</span></label>' +
          '<textarea name="modelMapping" rows="2" placeholder=\'{"gpt-4o": "gpt-4o-2024-11-20"}\'>' + esc(mappingJson) + '</textarea></div>' +

        '<div class="form-section span2">' + esc(t('Authentication')) + '</div>' +
        '<div class="field"><label>' + esc(t('Key header')) + '</label>' +
          '<input name="keyHeader" value="' + esc(ch.keyHeader != null ? ch.keyHeader : 'Authorization') + '"></div>' +
        '<div class="field"><label>' + esc(t('Key prefix')) + '</label>' +
          '<input name="keyPrefix" value="' + esc(ch.keyPrefix != null ? ch.keyPrefix : 'Bearer ') + '"></div>' +

        '<div class="form-section span2">' + esc(t('API keys')) + '</div>' +
        (isEdit ? '<div class="span2" id="modal-keys"><div class="hint" style="margin-bottom:8px">' + esc(t('Loading keys…')) + '</div></div>' : '') +
        '<div class="field span2"><label>' + esc(isEdit ? t('Add keys') : t('API keys')) + ' <span class="muted">' + esc(t('(one per line, optional)')) + '</span></label>' +
          '<textarea name="keys" rows="3" placeholder="sk-...&#10;sk-..."></textarea>' +
          (isEdit ? '<div class="hint">' + esc(t('New keys are imported when you save. Duplicates are skipped.')) + '</div>' : '') +
        '</div>' +

        '<div class="field span2" style="margin-top:4px"><label class="checklab"><input type="checkbox" name="enabled"' +
          ((isEdit ? ch.enabled : true) ? ' checked' : '') + '> ' + esc(t('Enabled')) + '</label></div>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn" data-action="modal-close">' + esc(t('Cancel')) + '</button>' +
        '<button type="submit" class="btn btn-primary">' + esc(isEdit ? t('Save changes') : t('Create channel')) + '</button>' +
      '</div>' +
    '</form>'
  );
  renderModelBox();
  if (isEdit) loadModalKeys(ch.id);
}

/* ----- key list inside the edit modal ----- */

async function loadModalKeys(chId) {
  const box = document.getElementById('modal-keys');
  if (!box) return;
  try {
    const reveal = !!store.revealKeys[chId];
    store.keysByChannel[chId] = (await api('/api/channels/' + encodeURIComponent(chId) + '/keys' + (reveal ? '?reveal=1' : ''))) || [];
  } catch (e) {
    box.innerHTML = '<div class="hint err-text" style="margin-bottom:8px">' + esc(e.message) + '</div>';
    return;
  }
  renderModalKeys(chId);
}

function renderModalKeys(chId) {
  const box = document.getElementById('modal-keys');
  if (!box) return;
  const keys = store.keysByChannel[chId] || [];
  if (!keys.length) {
    box.innerHTML = '<div class="hint" style="margin-bottom:8px">' + esc(t('No keys in this channel. Import some below.')) + '</div>';
    return;
  }
  box.innerHTML =
    '<div class="modal-keys-list">' +
    keys.map((k) => {
      const st = k.stats || {};
      return '<div class="mk-row">' +
        '<span class="mono mk-key" title="' + esc(k.key) + '">' + esc(k.key) + '</span>' +
        keyBadgeHtml(k) +
        '<span class="muted small mk-stats">' + esc(t('{failed}/{total} failed', { failed: fmtNum(st.failed || 0), total: fmtNum(st.requests || 0) })) + '</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn btn-sm" data-action="modal-key-toggle" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '" data-enabled="' + (k.enabled ? 'false' : 'true') + '">' + esc(k.enabled ? t('Disable') : t('Enable')) + '</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="modal-key-delete" data-id="' + esc(k.id) + '" data-ch="' + esc(chId) + '">' + esc(t('Delete')) + '</button>' +
      '</div>';
    }).join('') +
    '</div>' +
    '<div class="hint" style="margin:6px 0 10px">' + esc(t('{n} keys', { n: keys.length })) + '</div>';
}

async function submitChannelForm(form) {
  const f = form.elements;
  const body = {
    name: f.name.value.trim(),
    baseUrl: f.baseUrl.value.trim(),
    proxy: f.proxy.value.trim(),
    priority: Number(f.priority.value) || 0,
    weight: Number(f.weight.value) || 0,
    models: modelSel ? modelSel.selected.slice() : [],
    keyHeader: f.keyHeader.value,
    keyPrefix: f.keyPrefix.value,
    enabled: f.enabled.checked,
  };
  const mapTxt = f.modelMapping.value.trim();
  if (mapTxt) {
    try {
      const parsed = JSON.parse(mapTxt);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body.modelMapping = parsed;
    } catch (e) {
      toast('Model mapping must be a valid JSON object', 'error');
      return;
    }
  } else {
    body.modelMapping = {};
  }
  const id = form.dataset.id;
  if (f.keys && f.keys.value.trim()) {
    body.keys = f.keys.value; // string, one key per line — server trims/dedupes
  }
  let r;
  if (id) {
    r = await api('/api/channels/' + encodeURIComponent(id), { method: 'PUT', body });
    toast('Channel updated', 'success');
  } else {
    r = await api('/api/channels', { method: 'POST', body });
    toast('Channel created', 'success');
  }
  if (r && r.imported && (r.imported.added || r.imported.skipped)) {
    toast(t('Imported: {added} added, {skipped} skipped', { added: r.imported.added, skipped: r.imported.skipped }),
      r.imported.added ? 'success' : 'info');
  }
  closeModal();
  await refreshChannelsAndKeys(store.expandedChannel);
}

/* ----- model tag selector (new-api style chips + searchable dropdown) ----- */

let modelSel = null; // { selected: [], options: [], query: '', open: false } — lives while the channel modal is open

function renderModelBox() {
  const box = document.querySelector('[data-model-box]');
  if (!box || !modelSel) return;
  box.innerHTML =
    modelSel.selected.map((m) =>
      '<span class="tag"><span class="tag-label" title="' + esc(m) + '">' + esc(m) + '</span>' +
      '<button type="button" class="tag-x" data-action="model-remove" data-model="' + esc(m) + '" aria-label="remove ' + esc(m) + '">&times;</button></span>'
    ).join('') +
    '<input type="text" data-model-input autocomplete="off" spellcheck="false" placeholder="' +
      (modelSel.selected.length ? '' : esc(t('Type or pick models…'))) + '" value="' + esc(modelSel.query) + '">';
  renderModelDropdown();
}

function renderModelDropdown() {
  const dd = document.querySelector('[data-model-dropdown]');
  if (!dd || !modelSel) return;
  if (!modelSel.open) { dd.classList.add('hidden'); return; }
  const q = modelSel.query.trim().toLowerCase();
  const sel = new Set(modelSel.selected);
  const opts = modelSel.options.filter((m) => !q || m.toLowerCase().indexOf(q) >= 0);
  const typed = modelSel.query.trim();
  const exact = !typed || sel.has(typed) || modelSel.options.some((m) => m.toLowerCase() === q);
  let html =
    '<div class="tag-dd-head">' +
      '<span class="muted small">' + esc(t('{sel} / {total} selected', { sel: modelSel.selected.length, total: modelSel.options.length })) + '</span>' +
      '<span class="spacer"></span>' +
      (opts.length ? '<button type="button" class="btn btn-sm" data-action="models-select-all">' + esc(t('Select all')) + '</button>' : '') +
    '</div>' +
    '<div class="tag-dd-list">';
  if (!exact) {
    html += '<button type="button" class="tag-opt tag-opt-add" data-action="model-add-custom" data-model="' + esc(typed) + '">+ ' +
      esc(t('Add "{name}"', { name: typed })) + '</button>';
  }
  html += opts.map((m) =>
    '<button type="button" class="tag-opt' + (sel.has(m) ? ' sel' : '') + '" data-action="model-opt" data-model="' + esc(m) + '">' +
      '<span class="check">✓</span><span class="opt-name" title="' + esc(m) + '">' + esc(m) + '</span>' +
    '</button>'
  ).join('');
  if (!opts.length && exact) {
    html += '<div class="tag-dd-empty">' + esc(t('Type a model name and press Enter to add it.')) + '</div>';
  }
  html += '</div>';
  dd.innerHTML = html;
  dd.classList.remove('hidden');
}

function focusModelInput() {
  const inp = document.querySelector('[data-model-input]');
  if (inp) {
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
}

function modelSelAdd(name) {
  name = String(name || '').trim();
  if (!name || !modelSel) return;
  if (modelSel.selected.indexOf(name) < 0) modelSel.selected.push(name);
  if (modelSel.options.indexOf(name) < 0) {
    modelSel.options.push(name);
    modelSel.options.sort((a, b) => a.localeCompare(b));
  }
  modelSel.query = '';
  renderModelBox();
  focusModelInput();
}

function modelSelToggle(name) {
  if (!modelSel) return;
  const i = modelSel.selected.indexOf(name);
  if (i >= 0) modelSel.selected.splice(i, 1);
  else modelSel.selected.push(name);
  renderModelBox(); // keeps the current query, so multi-picking under a filter works
  focusModelInput();
}

/* ----- fetch /v1/models from the upstream into the selector options ----- */

async function fetchModelsForForm(btn) {
  const form = document.getElementById('channel-form');
  if (!form || !modelSel) return;
  const f = form.elements;
  const hint = document.getElementById('fetch-models-hint');
  const setHint = (text, isErr) => {
    if (hint) { hint.textContent = text; hint.className = 'hint' + (isErr ? ' err-text' : ''); }
  };
  const baseUrl = f.baseUrl.value.trim();
  if (!baseUrl) {
    setHint(t('Enter a Base URL first'), true);
    return;
  }
  const body = {
    baseUrl: baseUrl,
    proxy: f.proxy.value.trim(),
    keyHeader: f.keyHeader.value,
    keyPrefix: f.keyPrefix.value,
  };
  if (form.dataset.id) body.channelId = form.dataset.id;
  // Borrow the first pasted key for the probe (falls back to a stored key server-side).
  if (f.keys && f.keys.value.trim()) {
    body.key = f.keys.value.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  }
  setHint(t('Fetching…'), false);
  try {
    const r = await withBusy(btn, () => api('/api/channels/fetch-models', { method: 'POST', body }));
    if (!r || !r.ok) {
      setHint(t('Fetch failed') +
        (r && r.statusCode ? ' · ' + r.statusCode : '') +
        (r && r.error ? ' · ' + truncate(r.error, 90) : ''), true);
      return;
    }
    setHint(t('{n} models · {ms}', { n: r.models.length, ms: fmtMs(r.latencyMs) }), false);
    if (!modelSel) return; // modal closed while fetching
    const known = new Set(modelSel.options);
    (r.models || []).forEach((m) => { if (!known.has(m)) modelSel.options.push(m); });
    modelSel.options.sort((a, b) => a.localeCompare(b));
    modelSel.open = true;
    renderModelDropdown();
    focusModelInput();
  } catch (err) {
    setHint(truncate(err.message, 110), true);
  }
}

/* ============================================================
 * Tokens
 * ============================================================ */

async function renderTokens() {
  $('#view').innerHTML =
    '<div class="view-head"><h2>' + esc(t('Access tokens')) + '</h2></div>' +
    '<div class="card">' +
      '<form id="token-create-form" class="inline-form">' +
        '<input name="name" required placeholder="' + esc(t('Token name (e.g. my-app)')) + '">' +
        '<button type="submit" class="btn btn-primary">' + esc(t('Create token')) + '</button>' +
      '</form>' +
      '<p class="hint" style="margin:10px 0 0">' + esc(t('Use this as the Bearer token when calling the pool’s /v1 endpoint.')) + '</p>' +
    '</div>' +
    '<div class="card flush"><div class="table-scroll"><table>' +
      '<thead><tr><th>' + esc(t('Name')) + '</th><th>' + esc(t('Token')) + '</th><th>' + esc(t('Enabled')) + '</th><th class="num">' + esc(t('Requests')) + '</th>' +
      '<th>' + esc(t('Created')) + '</th><th>' + esc(t('Last used')) + '</th><th>' + esc(t('Actions')) + '</th></tr></thead>' +
      '<tbody id="tokens-tbody"><tr><td colspan="7" class="empty">' + esc(t('Loading…')) + '</td></tr></tbody>' +
    '</table></div></div>';

  try {
    store.tokens = (await api('/api/tokens')) || [];
    renderTokensTable();
  } catch (e) {
    const tbody = $('#tokens-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty">' + esc(t('Failed to load tokens.')) + '</td></tr>';
    toast(e.message, 'error');
  }
}

function renderTokensTable() {
  const tbody = $('#tokens-tbody');
  if (!tbody) return;
  if (!store.tokens.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">' + esc(t('No access tokens yet. Create one so clients can call /v1.')) + '</td></tr>';
    return;
  }
  tbody.innerHTML = store.tokens.map((tk) => {
    return '<tr>' +
      '<td><div class="cell-title">' + esc(tk.name) + '</div></td>' +
      '<td><span class="mono">' + esc(tk.token) + '</span> ' +
        '<button class="btn btn-sm" data-action="token-copy" data-token="' + esc(tk.token) + '">' + esc(t('Copy')) + '</button></td>' +
      '<td><label class="switch"><input type="checkbox" data-toggle="token" data-id="' + esc(tk.id) + '"' +
        (tk.enabled ? ' checked' : '') + '><span class="sl"></span></label></td>' +
      '<td class="num">' + fmtNum(tk.requests || 0) + '</td>' +
      '<td class="muted small">' + esc(fmtDate(tk.createdAt)) + '</td>' +
      '<td class="muted small" data-ago-ts="' + esc(tk.lastUsedAt || '') + '">' + esc(fmtAgo(tk.lastUsedAt)) + '</td>' +
      '<td class="actions"><button class="btn btn-sm btn-danger" data-action="token-delete" data-id="' + esc(tk.id) + '">' + esc(t('Delete')) + '</button></td>' +
      '</tr>';
  }).join('');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success');
  } catch (e) {
    // Clipboard API can be unavailable on http:// origins — fall back.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied to clipboard', 'success');
    } catch (e2) {
      toast('Copy failed. Select the token manually.', 'error');
    }
    ta.remove();
  }
}

/* ============================================================
 * Logs
 * ============================================================ */

async function renderLogs() {
  const f = store.logFilters;
  $('#view').innerHTML =
    '<div class="view-head"><h2>' + esc(t('Request logs')) + '</h2></div>' +
    '<div class="card">' +
      '<form id="logs-filter" class="filters">' +
        '<input type="search" name="q" placeholder="' + esc(t('Search model, path, key, error…')) + '" value="' + esc(f.q) + '">' +
        '<select name="channelId" id="logs-channel-sel"><option value="">' + esc(t('All channels')) + '</option></select>' +
        '<select name="status">' +
          '<option value="">' + esc(t('All statuses')) + '</option>' +
          '<option value="success"' + (f.status === 'success' ? ' selected' : '') + '>' + esc(t('Success')) + '</option>' +
          '<option value="error"' + (f.status === 'error' ? ' selected' : '') + '>' + esc(t('Error')) + '</option>' +
        '</select>' +
        '<select name="limit">' +
          [50, 100, 200, 500].map((n) =>
            '<option value="' + n + '"' + (Number(f.limit) === n ? ' selected' : '') + '>' + esc(t('{n} rows', { n: n })) + '</option>').join('') +
        '</select>' +
        '<button type="button" class="btn" data-action="logs-refresh">' + esc(t('Refresh')) + '</button>' +
      '</form>' +
    '</div>' +
    '<div class="card flush"><div class="table-scroll"><table>' +
      '<thead><tr><th>' + esc(t('Time')) + '</th><th>' + esc(t('Status')) + '</th><th>' + esc(t('Model')) + '</th><th>' + esc(t('Path')) + '</th><th>' + esc(t('Channel')) + '</th><th>' + esc(t('Key')) + '</th>' +
      '<th class="num">' + esc(t('Attempts')) + '</th><th class="num">' + esc(t('Latency')) + '</th><th class="num">' + esc(t('Tokens used')) + '</th></tr></thead>' +
      '<tbody id="logs-tbody"><tr><td colspan="9" class="empty">' + esc(t('Loading…')) + '</td></tr></tbody>' +
    '</table></div></div>';

  // Channel dropdown needs channel names.
  try {
    if (!store.channels.length) await loadChannelsData();
  } catch (e) { /* dropdown just stays empty */ }
  const sel = $('#logs-channel-sel');
  if (sel) {
    sel.innerHTML = '<option value="">' + esc(t('All channels')) + '</option>' + store.channels.map((ch) =>
      '<option value="' + esc(ch.id) + '"' + (f.channelId === ch.id ? ' selected' : '') + '>' + esc(ch.name) + '</option>'
    ).join('');
  }

  await fetchLogs();
}

async function fetchLogs() {
  const f = store.logFilters;
  const p = new URLSearchParams();
  p.set('limit', f.limit || 100);
  if (f.channelId) p.set('channelId', f.channelId);
  if (f.status) p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  try {
    store.logs = (await api('/api/logs?' + p.toString())) || [];
    renderLogsTable();
  } catch (e) {
    const tbody = $('#logs-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="empty">' + esc(t('Failed to load logs.')) + '</td></tr>';
    toast(e.message, 'error');
  }
}

function readLogFilters() {
  const form = $('#logs-filter');
  if (!form) return;
  store.logFilters = {
    q: form.elements.q.value.trim(),
    channelId: form.elements.channelId.value,
    status: form.elements.status.value,
    limit: Number(form.elements.limit.value) || 100,
  };
}

function logMatchesFilters(en) {
  const f = store.logFilters;
  if (f.channelId && en.channelId !== f.channelId) return false;
  if (f.status && en.status !== f.status) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [en.model, en.path, en.channelName, en.keyMasked, en.error, en.id]
      .map((x) => String(x == null ? '' : x).toLowerCase()).join(' ');
    if (hay.indexOf(q) < 0) return false;
  }
  return true;
}

function renderLogsTable() {
  const tbody = $('#logs-tbody');
  if (!tbody) return;
  if (!store.logs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">' + esc(t('No log entries match.')) + '</td></tr>';
    return;
  }
  tbody.innerHTML = store.logs.map((en) => {
    const expanded = store.expandedLogs.has(en.id);
    const tokens = (Number(en.promptTokens) || 0) + (Number(en.completionTokens) || 0);
    let html = '<tr class="row-click' + (expanded ? ' row-expanded' : '') + '" data-log-row="' + esc(en.id) + '">' +
      '<td class="muted small">' + esc(fmtTime(en.ts)) + '</td>' +
      '<td>' + statusBadgeHtml(en) + '</td>' +
      '<td>' + esc(en.model || '–') + '</td>' +
      '<td class="mono small">' + esc(truncate(en.path || '', 34)) + '</td>' +
      '<td>' + esc(en.channelName || '–') + '</td>' +
      '<td class="mono">' + esc(en.keyMasked || '–') + '</td>' +
      '<td class="num">' + esc(en.attempts != null ? en.attempts : 1) + '</td>' +
      '<td class="num">' + fmtMs(en.latencyMs) + '</td>' +
      '<td class="num">' + (tokens ? fmtNum(tokens) : '<span class="muted">–</span>') + '</td>' +
      '</tr>';
    if (expanded) {
      html += '<tr><td colspan="9" class="nopad"><div class="log-detail">' + logDetailHtml(en) + '</div></td></tr>';
    }
    return html;
  }).join('');
}

function logDetailHtml(en) {
  let html = '<div><span class="muted">' + esc(t('Request:')) + '</span> <span class="mono">' +
    esc(en.method || 'POST') + ' ' + esc(en.path || '') + '</span>' +
    (en.stream ? ' <span class="badge badge-neutral">' + esc(t('stream')) + '</span>' : '') +
    ' <span class="muted">· id ' + esc(en.id) + '</span></div>';
  html += '<div><span class="muted">' + esc(t('Tokens:')) + '</span> ' +
    esc(t('{p} prompt / {c} completion', { p: fmtNum(en.promptTokens || 0), c: fmtNum(en.completionTokens || 0) })) + '</div>';
  if (en.error) {
    html += '<div class="err-text"><span class="muted">' + esc(t('Error:')) + '</span> ' + esc(en.error) + '</div>';
  }
  const retries = en.retriesDetail || [];
  if (retries.length) {
    html += '<div><span class="muted">' + esc(t('Retries ({n}):', { n: retries.length })) + '</span></div>' +
      '<div class="table-scroll"><table>' +
      '<thead><tr><th>#</th><th>' + esc(t('Channel')) + '</th><th>' + esc(t('Key')) + '</th><th class="num">' + esc(t('Status')) + '</th><th>' + esc(t('Error')) + '</th></tr></thead><tbody>' +
      retries.map((r, i) =>
        '<tr><td class="muted">' + (i + 1) + '</td>' +
        '<td>' + esc(r.channelName || '–') + '</td>' +
        '<td class="mono">' + esc(r.keyMasked || '–') + '</td>' +
        '<td class="num">' + esc(r.statusCode != null ? r.statusCode : '–') + '</td>' +
        '<td class="err-cell" style="max-width:340px" title="' + esc(r.error || '') + '">' + esc(truncate(r.error || '', 80)) + '</td></tr>'
      ).join('') +
      '</tbody></table></div>';
  } else {
    html += '<div class="muted">' + esc(en.status === 'success'
      ? t('No retries. The first attempt succeeded.')
      : t('No retries. The first attempt failed.')) + '</div>';
  }
  return html;
}

/* ============================================================
 * Settings
 * ============================================================ */

// [value, label key, description key] — labels/descriptions resolve through t()
const STRATEGIES = [
  ['adaptive', 'Smart (adaptive)', 'Scores keys by latency, errors and load, picks the best (recommended).'],
  ['round_robin', 'Round robin', 'Cycles through active keys in fixed order.'],
  ['random', 'Random', 'Picks a uniformly random active key.'],
  ['weighted', 'Weighted', 'Random pick biased by channel weight.'],
  ['least_inflight', 'Least in-flight', 'Prefers the key with the fewest requests in flight.'],
  ['lowest_latency', 'Lowest latency', 'Prefers the key with the lowest recent average latency.'],
];

async function renderSettings() {
  $('#view').innerHTML =
    '<div class="view-head"><h2>' + esc(t('Settings')) + '</h2></div>' +
    '<div class="card"><div id="settings-box" class="empty">' + esc(t('Loading…')) + '</div></div>';
  try {
    store.settings = await api('/api/settings');
    renderSettingsForm();
  } catch (e) {
    const box = $('#settings-box');
    if (box) box.textContent = t('Failed to load settings.');
    toast(e.message, 'error');
  }
}

function renderSettingsForm() {
  const s = store.settings || {};
  const box = $('#settings-box');
  if (!box) return;
  box.className = '';
  box.innerHTML =
    '<form id="settings-form" class="settings-form">' +
      '<div class="field"><label>' + esc(t('Key selection strategy')) + '</label>' +
        '<select name="strategy" id="set-strategy">' +
          STRATEGIES.map(([v, label]) =>
            '<option value="' + v + '"' + (s.strategy === v ? ' selected' : '') + '>' + esc(t(label)) + '</option>').join('') +
        '</select>' +
        '<ul class="strategy-list" id="strategy-list">' +
          STRATEGIES.map(([v, label, d]) =>
            '<li data-strategy="' + v + '"><code>' + esc(t(label)) + '</code> · ' + esc(t(d)) + '</li>').join('') +
        '</ul>' +
      '</div>' +
      '<div class="form-grid">' +
        numField('maxAttempts', t('Max attempts'), s.maxAttempts, t('Total tries per request (first attempt + retries).')) +
        numField('requestTimeoutMs', t('Request timeout (ms)'), s.requestTimeoutMs, t('Overall upstream request timeout.')) +
        numField('connectTimeoutMs', t('Connect timeout (ms)'), s.connectTimeoutMs, t('Upstream connection timeout.')) +
        numField('cooldown429BaseMs', t('Cooldown after 429 (ms)'), s.cooldown429BaseMs, t('Base cooldown when a key gets rate-limited.')) +
        numField('cooldownErrorBaseMs', t('Cooldown after error (ms)'), s.cooldownErrorBaseMs, t('Base cooldown after other upstream errors.')) +
        numField('cooldownMaxMs', t('Max cooldown (ms)'), s.cooldownMaxMs, t('Upper bound for exponential cooldown.')) +
        numField('disableAfterConsecutiveFailures', t('Disable after failures'), s.disableAfterConsecutiveFailures, t('Auto-disable a key after this many consecutive failures.')) +
        numField('logLimit', t('Log limit'), s.logLimit, t('Number of request logs kept in memory.')) +
        '<div class="field span2"><label>' + esc(t('Retry on status codes')) + ' <span class="muted">' + esc(t('(comma-separated)')) + '</span></label>' +
          '<input name="retryOn" value="' + esc((s.retryOn || []).join(', ')) + '" placeholder="429, 500, 502, 503, 504">' +
          '<div class="hint">' + esc(t('A response with one of these codes triggers a retry on another key.')) + '</div></div>' +
        '<div class="field span2"><label class="checklab"><input type="checkbox" name="allowAnonymous"' +
          (s.allowAnonymous ? ' checked' : '') + '> ' + esc(t('Allow anonymous access to /v1 (no access token required)')) + '</label></div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button type="submit" class="btn btn-primary">' + esc(t('Save settings')) + '</button>' +
        '<span class="save-note" id="save-note">' + esc(t('Saved ✓')) + '</span>' +
      '</div>' +
    '</form>';
  updateStrategyHelp();
}

function numField(name, label, value, hint) {
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<input type="number" name="' + esc(name) + '" step="1" min="0" required value="' + esc(value != null ? value : '') + '">' +
    (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
}

function updateStrategyHelp() {
  const sel = $('#set-strategy');
  if (!sel) return;
  $$('#strategy-list li').forEach((li) => {
    li.classList.toggle('sel', li.dataset.strategy === sel.value);
  });
}

async function submitSettingsForm(form) {
  const f = form.elements;
  const retryOn = f.retryOn.value.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (retryOn.some((n) => !Number.isInteger(n) || n < 100 || n > 599)) {
    toast(t('Retry codes must be HTTP status codes (100–599)'), 'error');
    return;
  }
  const body = {
    strategy: f.strategy.value,
    maxAttempts: Number(f.maxAttempts.value),
    requestTimeoutMs: Number(f.requestTimeoutMs.value),
    connectTimeoutMs: Number(f.connectTimeoutMs.value),
    cooldown429BaseMs: Number(f.cooldown429BaseMs.value),
    cooldownErrorBaseMs: Number(f.cooldownErrorBaseMs.value),
    cooldownMaxMs: Number(f.cooldownMaxMs.value),
    disableAfterConsecutiveFailures: Number(f.disableAfterConsecutiveFailures.value),
    retryOn: retryOn,
    allowAnonymous: f.allowAnonymous.checked,
    logLimit: Number(f.logLimit.value),
  };
  store.settings = await api('/api/settings', { method: 'PUT', body });
  toast('Settings saved', 'success');
  const note = $('#save-note');
  if (note) {
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  }
}

/* ============================================================
 * Global event wiring
 * ============================================================ */

document.addEventListener('click', async (e) => {
  // Clicking outside the model selector closes its dropdown.
  if (modelSel && modelSel.open && !e.target.closest('[data-model-widget]')) {
    modelSel.open = false;
    renderModelDropdown();
  }

  const actEl = e.target.closest('[data-action]');
  if (actEl) {
    e.preventDefault();
    await runAction(actEl).catch((err) => toast(err.message, 'error'));
    return;
  }

  // Clicking the model selector box focuses its input and opens the list.
  const mbox = e.target.closest('[data-model-box]');
  if (mbox) {
    if (modelSel) {
      modelSel.open = true;
      renderModelDropdown();
    }
    const inp = mbox.querySelector('[data-model-input]');
    if (inp) inp.focus();
    return;
  }

  // Expand/collapse channel row -> key panel
  const chRow = e.target.closest('tr[data-channel-row]');
  if (chRow && !e.target.closest('[data-stop]')) {
    const id = chRow.getAttribute('data-channel-row');
    if (store.expandedChannel === id) {
      store.expandedChannel = null;
    } else {
      store.expandedChannel = id;
      store.selectedKeys.clear();
    }
    renderChannelsTable();
    if (store.expandedChannel && store.keysByChannel[store.expandedChannel] === undefined) {
      loadKeysAndRender(store.expandedChannel);
    }
    return;
  }

  // Expand/collapse log row
  const logRow = e.target.closest('tr[data-log-row]');
  if (logRow && !e.target.closest('[data-stop]')) {
    const id = logRow.getAttribute('data-log-row');
    if (store.expandedLogs.has(id)) store.expandedLogs.delete(id);
    else store.expandedLogs.add(id);
    renderLogsTable();
  }
});

async function runAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  const chId = el.dataset.ch;

  switch (action) {
    case 'logout':
      await doLogout();
      break;

    case 'modal-close':
      closeModal();
      break;

    case 'channel-add':
      openChannelModal(null);
      break;

    case 'fetch-models':
      await fetchModelsForForm(el);
      break;

    case 'model-remove': {
      if (!modelSel) break;
      const i = modelSel.selected.indexOf(el.dataset.model);
      if (i >= 0) modelSel.selected.splice(i, 1);
      renderModelBox();
      focusModelInput();
      break;
    }

    case 'model-opt':
      modelSelToggle(el.dataset.model);
      break;

    case 'model-add-custom':
      modelSelAdd(el.dataset.model);
      break;

    case 'models-select-all': {
      if (!modelSel) break;
      const q = modelSel.query.trim().toLowerCase();
      modelSel.options
        .filter((m) => !q || m.toLowerCase().indexOf(q) >= 0)
        .forEach((m) => { if (modelSel.selected.indexOf(m) < 0) modelSel.selected.push(m); });
      renderModelBox();
      focusModelInput();
      break;
    }

    case 'models-clear':
      if (!modelSel) break;
      modelSel.selected = [];
      renderModelBox();
      focusModelInput();
      break;

    case 'channel-edit': {
      const ch = store.channels.find((c) => c.id === id);
      if (ch) openChannelModal(ch);
      break;
    }

    case 'channel-delete': {
      const ch = store.channels.find((c) => c.id === id);
      const name = ch ? ch.name : id;
      if (!confirm(t('Delete channel "{name}" and all of its keys?', { name: name }))) return;
      await withBusy(el, () => api('/api/channels/' + encodeURIComponent(id), { method: 'DELETE' }));
      if (store.expandedChannel === id) store.expandedChannel = null;
      delete store.keysByChannel[id];
      toast('Channel deleted', 'success');
      await refreshChannelsAndKeys(null);
      break;
    }

    case 'channel-test': {
      store.channelTest[id] = { state: 'testing' };
      const cell = document.querySelector('[data-chtest="' + cssEsc(id) + '"]');
      if (cell) cell.innerHTML = chTestHtml(id);
      try {
        const r = await withBusy(el, () => api('/api/channels/fetch-models', { method: 'POST', body: { channelId: id } }));
        store.channelTest[id] = {
          state: 'done',
          ok: !!(r && r.ok),
          statusCode: (r && r.statusCode) || 0,
          latencyMs: r && r.latencyMs,
          error: r && r.error,
        };
      } catch (err) {
        store.channelTest[id] = { state: 'done', ok: false, statusCode: 0, latencyMs: null, error: err.message };
      }
      const done = document.querySelector('[data-chtest="' + cssEsc(id) + '"]');
      if (done) done.innerHTML = chTestHtml(id);
      break;
    }

    case 'channels-refresh':
      await withBusy(el, () => refreshChannelsAndKeys(store.expandedChannel));
      break;

    case 'modal-key-toggle': {
      const enabled = el.dataset.enabled === 'true';
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: enabled } }));
      toast('Key ' + (enabled ? 'enabled' : 'disabled'), 'success');
      await loadModalKeys(chId);
      await loadChannelsData();
      if (store.route === 'channels') renderChannelsTable();
      break;
    }

    case 'modal-key-delete': {
      if (!confirm(t('Delete this key?'))) return;
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' }));
      store.selectedKeys.delete(id);
      toast('Key deleted', 'success');
      store.keysByChannel[chId] = (store.keysByChannel[chId] || []).filter((k) => k.id !== id);
      renderModalKeys(chId);
      await loadChannelsData();
      if (store.route === 'channels') renderChannelsTable();
      break;
    }

    case 'problem-key-reset': {
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id) + '/reset', { method: 'POST' }));
      toast('Key reset', 'success');
      try { store.overview = await api('/api/overview'); } catch (e) { /* banner refresh is best-effort */ }
      renderDashStats();
      break;
    }

    case 'key-toggle': {
      const enabled = el.dataset.enabled === 'true';
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: enabled } }));
      toast('Key ' + (enabled ? 'enabled' : 'disabled'), 'success');
      await refreshChannelsAndKeys(chId);
      break;
    }

    case 'key-reset':
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id) + '/reset', { method: 'POST' }));
      toast('Key reset', 'success');
      await refreshChannelsAndKeys(chId);
      break;

    case 'key-test': {
      const out = document.querySelector('[data-test-result="' + cssEsc(id) + '"]');
      if (out) { out.textContent = t('Testing…'); out.className = 'test-result muted'; }
      try {
        const r = await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id) + '/test', { method: 'POST' }));
        const fresh = document.querySelector('[data-test-result="' + cssEsc(id) + '"]');
        if (fresh) {
          if (r && r.ok) {
            fresh.textContent = 'OK · ' + r.statusCode + ' · ' + fmtMs(r.latencyMs);
            fresh.className = 'test-result ok-text';
          } else {
            fresh.textContent = t('Failed') +
              (r && r.statusCode ? ' · ' + r.statusCode : '') +
              (r && r.error ? ' · ' + truncate(r.error, 70) : '');
            fresh.className = 'test-result err-text';
          }
        }
      } catch (err) {
        const fresh = document.querySelector('[data-test-result="' + cssEsc(id) + '"]');
        if (fresh) { fresh.textContent = t('Test failed · {err}', { err: truncate(err.message, 70) }); fresh.className = 'test-result err-text'; }
        throw err;
      }
      break;
    }

    case 'key-delete':
      if (!confirm(t('Delete this key?'))) return;
      await withBusy(el, () => api('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' }));
      store.selectedKeys.delete(id);
      toast('Key deleted', 'success');
      await refreshChannelsAndKeys(chId);
      break;

    case 'keys-delete-selected': {
      const ids = Array.from(store.selectedKeys);
      if (!ids.length) return;
      if (!confirm(t('Delete {n} selected keys?', { n: ids.length }))) return;
      const r = await withBusy(el, () => api('/api/keys/batch-delete', { method: 'POST', body: { ids: ids } }));
      store.selectedKeys.clear();
      toast(t('Deleted {n} keys', { n: (r && r.deleted) != null ? r.deleted : ids.length }), 'success');
      await refreshChannelsAndKeys(id); // data-id on this button is the channel id
      break;
    }

    case 'keys-import': {
      const ta = document.getElementById('import-keys-' + id);
      const text = ta ? ta.value : '';
      if (!text.trim()) { toast('Paste at least one key first', 'error'); return; }
      const r = await withBusy(el, () =>
        api('/api/channels/' + encodeURIComponent(id) + '/keys', { method: 'POST', body: { keys: text } }));
      const added = r && r.added != null ? r.added : 0;
      const skipped = r && r.skipped != null ? r.skipped : 0;
      toast(t('Imported: {added} added, {skipped} skipped', { added: added, skipped: skipped }), added ? 'success' : 'info');
      await refreshChannelsAndKeys(id);
      const res = document.getElementById('import-result-' + id);
      if (res) res.textContent = t('{added} added, {skipped} skipped', { added: added, skipped: skipped });
      break;
    }

    case 'token-copy':
      await copyText(el.dataset.token || '');
      break;

    case 'token-delete': {
      if (!confirm(t('Delete this access token? Clients using it will stop working.'))) return;
      await withBusy(el, () => api('/api/tokens/' + encodeURIComponent(id), { method: 'DELETE' }));
      toast('Token deleted', 'success');
      store.tokens = (await api('/api/tokens')) || [];
      renderTokensTable();
      break;
    }

    case 'logs-refresh':
      readLogFilters();
      await fetchLogs();
      break;
  }
}

async function withBusy(btn, fn) {
  if (btn && btn.tagName === 'BUTTON') btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn && btn.tagName === 'BUTTON' && document.contains(btn)) btn.disabled = false;
  }
}

/* ----- change events (toggles, selects, checkboxes) ----- */

document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.matches('[data-lang-sel]')) {
      setLang(el.value);
      renderConnStatus();
      if (store.auth.username !== null) onRoute(); // re-render the current view in the new language

    } else if (el.matches('[data-toggle="channel"]')) {
      await api('/api/channels/' + encodeURIComponent(el.dataset.id), { method: 'PUT', body: { enabled: el.checked } });
      toast('Channel ' + (el.checked ? 'enabled' : 'disabled'), 'success');
      await refreshChannelsAndKeys(store.expandedChannel);

    } else if (el.matches('[data-toggle="token"]')) {
      await api('/api/tokens/' + encodeURIComponent(el.dataset.id), { method: 'PATCH', body: { enabled: el.checked } });
      const tok = store.tokens.find((x) => x.id === el.dataset.id);
      if (tok) tok.enabled = el.checked;
      toast('Token ' + (el.checked ? 'enabled' : 'disabled'), 'success');

    } else if (el.matches('[data-reveal]')) {
      store.revealKeys[el.dataset.id] = el.checked;
      await loadKeysAndRender(el.dataset.id);

    } else if (el.matches('[data-keysel]')) {
      if (el.checked) store.selectedKeys.add(el.dataset.keysel);
      else store.selectedKeys.delete(el.dataset.keysel);
      updateBatchBar();

    } else if (el.matches('[data-keysel-all]')) {
      const keys = store.keysByChannel[el.dataset.id] || [];
      keys.forEach((k) => {
        if (el.checked) store.selectedKeys.add(k.id);
        else store.selectedKeys.delete(k.id);
      });
      $$('[data-keysel]').forEach((cb) => { cb.checked = el.checked; });
      updateBatchBar();

    } else if (el.closest('#logs-filter') && el.name !== 'q') {
      readLogFilters();
      await fetchLogs();

    } else if (el.id === 'set-strategy') {
      updateStrategyHelp();
    }
  } catch (err) {
    toast(err.message, 'error');
    if (el.type === 'checkbox') el.checked = !el.checked; // revert failed toggle
  }
});

/* ----- debounced free-text log search ----- */

let logSearchTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.matches('#logs-filter input[name="q"]')) {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => {
      readLogFilters();
      fetchLogs();
    }, 300);
  } else if (e.target.matches('[data-model-input]')) {
    if (modelSel) {
      modelSel.query = e.target.value;
      modelSel.open = true;
      renderModelDropdown();
    }
  } else if (e.target.matches('[data-channel-search]')) {
    store.channelFilter = e.target.value;
    renderChannelsTable();
  }
});

/* ----- form submits ----- */

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  try {
    if (form.id === 'login-form') {
      await doLogin(form);
    } else if (form.id === 'channel-form') {
      await submitChannelForm(form);
    } else if (form.id === 'token-create-form') {
      const name = form.elements.name.value.trim();
      if (!name) return;
      await api('/api/tokens', { method: 'POST', body: { name: name } });
      form.reset();
      toast('Token created', 'success');
      store.tokens = (await api('/api/tokens')) || [];
      renderTokensTable();
    } else if (form.id === 'settings-form') {
      await submitSettingsForm(form);
    } else if (form.id === 'logs-filter') {
      readLogFilters();
      await fetchLogs();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ----- keyboard ----- */

document.addEventListener('keydown', (e) => {
  // Model tag input: Enter/comma adds, Backspace pops, Escape closes the dropdown only.
  if (e.target.matches && e.target.matches('[data-model-input]') && modelSel) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault(); // never submit the channel form from here
      const v = e.target.value.trim();
      if (v) modelSelAdd(v);
      return;
    }
    if (e.key === 'Backspace' && e.target.value === '' && modelSel.selected.length) {
      modelSel.selected.pop();
      renderModelBox();
      focusModelInput();
      return;
    }
    if (e.key === 'Escape' && modelSel.open) {
      modelSel.open = false;
      renderModelDropdown();
      return;
    }
  }
  if (e.key === 'Escape' && !$('#modal-root').classList.contains('hidden')) {
    closeModal();
  }
});

/* ----- 1s ticker: elapsed timers, cooldown countdowns, relative times ----- */

setInterval(() => {
  const now = Date.now();

  $$('[data-elapsed-ts]').forEach((el) => {
    const ts = Number(el.dataset.elapsedTs);
    if (ts) el.textContent = fmtMs(now - ts);
  });

  $$('[data-cooldown-until]').forEach((el) => {
    const until = Number(el.dataset.cooldownUntil) || 0;
    const remain = Math.ceil((until - now) / 1000);
    if (remain > 0) {
      el.textContent = t('cooldown · {n}s', { n: remain });
    } else {
      // Cooldown elapsed — optimistically flip to active until the server says otherwise.
      el.textContent = t('active');
      el.classList.remove('badge-cooldown');
      el.classList.add('badge-active');
      el.removeAttribute('data-cooldown-until');
    }
  });

  $$('[data-ago-ts]').forEach((el) => {
    const ts = Number(el.dataset.agoTs);
    el.textContent = fmtAgo(ts || 0);
  });
}, 1000);

/* ----- redraw chart on resize ----- */

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (store.route === 'dashboard') drawHistoryChart();
  }, 150);
});

/* ----- routing + boot ----- */

window.addEventListener('hashchange', onRoute);
boot();
