import { createApiClient } from './apiClient.js';

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const TOKEN_KEY = 'codexRouterAdminToken';
  let authPromptSuppressed = false;

  const state = {
    status: null,
    usage: null,
    codex: null,
    configLoaded: false,
    configDirty: false,
    days: 7
  };

  const VIEW_TITLES = { overview: '总览', usage: '用量统计', codex: 'Codex 配置', config: '配置' };

  /* ---------- helpers ---------- */

  const requestApi = createApiClient({
    getToken: () => {
      try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
    }
  });

  async function api(path, options = {}) {
    try {
      return await requestApi(path, options);
    } catch (error) {
      if (error?.status !== 401 || authPromptSuppressed) throw error;
      const token = prompt('远程管理需要 Bearer 令牌。令牌只保存在当前标签页，不会写入配置或日志。', '');
      if (token === null) {
        authPromptSuppressed = true;
        throw error;
      }
      if (!token.trim()) {
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
        throw error;
      }
      try { sessionStorage.setItem(TOKEN_KEY, token.trim()); } catch { /* noop */ }
      authPromptSuppressed = false;
      try {
        return await requestApi(path, options);
      } catch (retryError) {
        if (retryError?.status === 401) {
          try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
          authPromptSuppressed = true;
          toast('管理令牌无效，请点击“管理令牌”重新输入', 'err');
        }
        throw retryError;
      }
    }
  }

  function editAuthToken() {
    const token = prompt('输入远程管理 Bearer 令牌；留空将清除当前标签页中的令牌。', '');
    if (token === null) return;
    try {
      if (token.trim()) sessionStorage.setItem(TOKEN_KEY, token.trim());
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* noop */ }
    authPromptSuppressed = false;
    toast(token.trim() ? '管理令牌已保存到当前标签页' : '管理令牌已清除', token.trim() ? 'ok' : 'warn');
    pollStatus();
  }

  function fmtInt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtKnownInt(n) {
    return n === null || n === undefined ? '—' : fmtInt(n);
  }

  function fmtUsd(value) {
    if (value === null || value === undefined) return '—';
    if (value === 0) return '$0.00';
    if (value < 0.01) return '$' + Number(value).toFixed(6);
    return '$' + Number(value).toFixed(2);
  }

  function fmtPct(x) {
    if (x === null || x === undefined) return '—';
    return (x * 100).toFixed(1) + '%';
  }

  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  }

  function badge(kind, text) {
    return `<span class="badge ${kind}">${escapeHtml(text)}</span>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function setConn(ok, text) {
    const dot = $('#connDot');
    dot.className = 'status-dot ' + (ok === null ? 'restarting' : ok ? 'ok' : 'down');
    $('#connText').textContent = text;
  }

  /* ---------- overview ---------- */

  function renderOverview() {
    const s = state.status;
    const usage = s?.usage || {};
    const cards = [
      { label: '服务状态', value: s ? '运行中' : '—', sub: s ? `PID ${s.pid} · 已运行 ${fmtUptime(s.uptimeSec)}` : '' },
      { label: '近 7 天请求', value: fmtInt(usage.totalRequests), sub: `成功率 ${fmtPct(usage.successRate)}` },
      { label: 'Token 总量', value: fmtInt(usage.totalTokens), sub: `输入 ${fmtInt(usage.totalInputTokens)} · 输出 ${fmtInt(usage.totalOutputTokens)}` },
      { label: '缓存命中率', value: fmtPct(usage.cacheHitRate), sub: `Hit ${fmtKnownInt(usage.totalCacheHitTokens)} · Miss ${fmtKnownInt(usage.totalCacheMissTokens)}` },
      { label: '估算费用', value: fmtUsd(usage.estimatedCostUsd), sub: `费用覆盖 ${fmtPct(usage.costCoverageRate)}` },
      { label: '平均延迟', value: fmtMs(usage.avgLatencyMs), sub: '近 7 天' }
    ];
    $('#overviewCards').innerHTML = cards.map((c) => `
      <div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>
    `).join('');

    const health = (s?.health || []).map((h) => `
      <tr>
        <td class="mono">${escapeHtml(h.model)}</td>
        <td class="mono">${escapeHtml(h.endpoint)}</td>
        <td>${h.unhealthy ? badge('red', '异常') : badge('green', '健康')}</td>
      </tr>
    `).join('');
    $('#healthTable').innerHTML = health || '<tr><td colspan="3" class="empty">健康检查未启用或暂无探测目标</td></tr>';

    const circuit = (s?.circuit || []).map((c) => {
      const kind = c.state === 'closed' ? 'green' : c.state === 'half_open' ? 'amber' : 'red';
      return `
        <tr>
          <td class="mono">${escapeHtml(c.key)}</td>
          <td>${badge(kind, { closed: '关闭', open: '熔断', half_open: '半开探测' }[c.state] || c.state)}</td>
          <td>${c.consecutiveFailures}</td>
          <td>${c.totalRequests} / ${c.failedRequests}</td>
        </tr>
      `;
    }).join('');
    $('#circuitTable').innerHTML = circuit || '<tr><td colspan="4" class="empty">熔断器未启用</td></tr>';
  }

  /* ---------- usage ---------- */

  function renderUsage() {
    const u = state.usage;
    if (!u) return;
    const compression = u.compression || {};
    const cards = [
      { label: '请求数', value: fmtInt(u.totalRequests), sub: `成功率 ${fmtPct(u.successRate)}` },
      { label: '输入 Token', value: fmtInt(u.totalInputTokens), sub: `Hit ${fmtKnownInt(u.totalCacheHitTokens)} · Miss ${fmtKnownInt(u.totalCacheMissTokens)}` },
      { label: '输出 Token', value: fmtInt(u.totalOutputTokens), sub: `缓存写 ${fmtKnownInt(u.totalCacheWriteTokens)}` },
      { label: '缓存命中率', value: fmtPct(u.cacheHitRate), sub: 'Hit / (Hit + Miss)' },
      { label: '估算费用', value: fmtUsd(u.estimatedCostUsd), sub: `缓存节省 ${fmtUsd(u.estimatedCacheSavingsUsd)} · 覆盖 ${fmtPct(u.costCoverageRate)}` },
      { label: '压缩 Checkpoint', value: fmtPct(compression.checkpointReuseRate), sub: `${fmtInt(compression.requests)} 次 · 前缀变化 ${fmtPct(compression.prefixChangedRate)}` },
      { label: '平均延迟', value: fmtMs(u.avgLatencyMs), sub: `${state.days === 0 ? '全部' : '近 ' + state.days + ' 天'}` }
    ];
    $('#usageCards').innerHTML = cards.map((c) => `
      <div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>
    `).join('');

    $('#usageChart').innerHTML = buildDayChart(u.perDay || {});

    const models = Object.entries(u.perModel || {})
      .sort((a, b) => b[1].requests - a[1].requests)
      .map(([name, m]) => `
        <tr>
          <td class="mono">${escapeHtml(name)}</td>
          <td>${m.requests}</td>
          <td>${fmtPct(m.successRate)}</td>
          <td>${fmtInt(m.input_tokens)}</td>
          <td>${fmtInt(m.output_tokens)}</td>
          <td>${fmtKnownInt(m.cache_hit_tokens)}</td>
          <td>${fmtKnownInt(m.cache_miss_tokens)}</td>
          <td>${fmtPct(m.cacheHitRate)}</td>
          <td>${fmtUsd(m.estimatedCostUsd)}</td>
          <td>${fmtMs(m.avgLatencyMs)}</td>
        </tr>
      `).join('');
    $('#modelTable').innerHTML = models || '<tr><td colspan="10" class="empty">暂无请求</td></tr>';

    const providers = Object.entries(u.perProvider || {})
      .sort((a, b) => b[1].requests - a[1].requests)
      .map(([name, p]) => `
        <tr>
          <td class="mono">${escapeHtml(name)}</td>
          <td>${p.requests}</td>
          <td>${fmtPct(p.successRate)}</td>
          <td>${fmtInt(p.total_tokens)}</td>
          <td>${fmtKnownInt(p.cache_hit_tokens)}</td>
          <td>${fmtKnownInt(p.cache_miss_tokens)}</td>
          <td>${fmtPct(p.cacheHitRate)}</td>
          <td>${fmtUsd(p.estimatedCostUsd)}</td>
          <td>${fmtMs(p.avgLatencyMs)}</td>
        </tr>
      `).join('');
    $('#providerTable').innerHTML = providers || '<tr><td colspan="9" class="empty">暂无请求</td></tr>';
  }

  function buildDayChart(perDay) {
    const days = Object.keys(perDay).sort();
    if (!days.length) return '<p class="empty">暂无数据</p>';
    const W = 860;
    const H = 200;
    const pad = { top: 14, right: 10, bottom: 28, left: 40 };
    const values = days.map((d) => perDay[d].requests);
    const max = Math.max(...values, 1);
    const bw = (W - pad.left - pad.right) / days.length;
    const bh = (d) => Math.max(2, (d / max) * (H - pad.top - pad.bottom));
    const bars = days.map((d, i) => {
      const x = pad.left + i * bw + bw * 0.18;
      const y = H - pad.bottom - bh(perDay[d].requests);
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${bh(perDay[d].requests).toFixed(1)}">
        <title>${escapeHtml(d)}: ${perDay[d].requests} 请求 · ${fmtInt(perDay[d].total_tokens)} tokens</title></rect>`;
    }).join('');
    const labels = days.map((d, i) => {
      const x = pad.left + i * bw + bw / 2;
      const show = days.length <= 10 || i % Math.ceil(days.length / 10) === 0;
      return show ? `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(d.slice(5))}</text>` : '';
    }).join('');
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const y = H - pad.bottom - t * (H - pad.top - pad.bottom);
      return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="#e6e8f0" stroke-width="1"/>
        <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${fmtInt(max * t)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="每日请求数">
      <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#7a8cff"/><stop offset="1" stop-color="#4f63e8"/>
      </linearGradient></defs>
      ${yTicks}${bars}${labels}
    </svg>`;
  }

  /* ---------- config ---------- */

  async function loadCodex() {
    try {
      const data = await api('/api/codex');
      state.codex = data.enabled ? data.status : null;
      if (currentView() === 'codex') renderCodex();
    } catch {
      state.codex = null;
    }
  }

  function renderCodex() {
    const s = state.codex;
    if (!s) {
      $('#codexCards').innerHTML = '<div class="card"><div class="label">Codex 管理</div><div class="value">未启用</div><div class="sub">config.codex.enabled = false</div></div>';
      $('#codexFields').innerHTML = '<tr><td colspan="3" class="empty">未启用</td></tr>';
      $('#codexBackups').innerHTML = '<tr><td colspan="4" class="empty">—</td></tr>';
      return;
    }
    const cards = [
      {
        label: 'minar_route',
        value: s.applied ? '已应用' : '未应用',
        sub: s.provider.blockExists ? 'provider 块已存在' : 'provider 块待创建'
      },
      { label: 'model_provider', value: s.activeModelProvider || '—', sub: `原始: ${s.originalModelProvider || '无标记'}` },
      { label: 'model', value: s.activeModel || '—', sub: `目标: ${s.provider.model}` },
      { label: '配置文件', value: s.exists ? '存在' : '缺失', sub: s.configPath }
    ];
    $('#codexCards').innerHTML = cards.map((c) => `
      <div class="card"><div class="label">${c.label}</div><div class="value">${escapeHtml(c.value)}</div><div class="sub">${escapeHtml(c.sub || '')}</div></div>
    `).join('');

    const rows = [
      ['model_provider', s.activeModelProvider || '—', s.originalModelProvider || '—'],
      ['model', s.activeModel || '—', s.originalModel || '—'],
      ['provider.name', s.provider.displayName, ''],
      ['provider.base_url', s.provider.baseUrl || '—', ''],
      ['model_catalog_json', s.modelCatalogJsonPresent ? '已配置' : '未配置（模型列表可能为空）', '']
    ];
    $('#codexFields').innerHTML = rows.map(([k, v, o]) => `
      <tr><td class="mono">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td><td class="mono">${escapeHtml(o)}</td></tr>
    `).join('');

    const backups = (s.backups || []).map((b) => `
      <tr>
        <td class="mono">${escapeHtml(b.name)}</td>
        <td>${new Date(b.mtime).toLocaleString()}</td>
        <td>${fmtInt(b.size)} B</td>
        <td><button class="btn ghost" type="button" data-backup="${escapeHtml(b.file)}">从该备份还原</button></td>
      </tr>
    `).join('');
    $('#codexBackups').innerHTML = backups || '<tr><td colspan="4" class="empty">暂无备份</td></tr>';
    $$('#codexBackups [data-backup]').forEach((btn) => btn.addEventListener('click', () => restoreFromBackup(btn.dataset.backup)));
  }

  async function applyCodex() {
    $('#btnCodexApply').disabled = true;
    try {
      const r = await api('/api/codex/apply', { method: 'POST' });
      toast(r.changed ? '已启用 minar_route，重启 Codex 会话后生效' : '已是 minar_route 状态', r.changed ? 'ok' : 'warn');
      await loadCodex();
    } catch (error) {
      toast('启用失败: ' + error.message, 'err');
    } finally {
      $('#btnCodexApply').disabled = false;
    }
  }

  async function restoreCodexMarker() {
    $('#btnCodexRestoreMarker').disabled = true;
    try {
      const r = await api('/api/codex/restore', { method: 'POST' });
      if (r.restored) {
        toast(`已按注释还原（${r.method}），重启 Codex 会话后生效`, 'ok');
      } else if (r.needsBackup) {
        toast('注释字段缺失，无法自动还原：请从下方备份选择恢复', 'warn');
      }
      await loadCodex();
    } catch (error) {
      toast('还原失败: ' + error.message, 'err');
    } finally {
      $('#btnCodexRestoreMarker').disabled = false;
    }
  }

  async function restoreFromBackup(file) {
    if (!confirm('确定用该备份覆盖 config.toml？当前状态会先自动备份。')) return;
    try {
      const r = await api('/api/codex/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, confirm: true }) });
      toast(r.restored ? '已从备份还原，重启 Codex 会话后生效' : '还原未完成', r.restored ? 'ok' : 'warn');
      await loadCodex();
    } catch (error) {
      toast('还原失败: ' + error.message, 'err');
    }
  }

  async function loadConfig() {
    if (state.configDirty) return;
    try {
      const data = await api('/api/config');
      $('#configEditor').value = typeof data.config === 'string' ? data.config : JSON.stringify(data.config, null, 2);
      state.configLoaded = true;
      state.configDirty = false;
    } catch (error) {
      toast('读取配置失败: ' + error.message, 'err');
    }
  }

  async function saveConfig() {
    const text = $('#configEditor').value;
    if (!text.trim()) { toast('配置为空', 'err'); return; }
    $('#btnSave').disabled = true;
    try {
      const res = await api('/api/reload', { method: 'POST', body: text });
      toast(res.message || '配置已保存并热加载', 'ok');
      state.configDirty = false;
      markRestarting();
    } catch (error) {
      toast('保存失败: ' + error.message, 'err');
    } finally {
      $('#btnSave').disabled = false;
    }
  }

  async function restartService() {
    if (!confirm('确定重启路由服务？正在进行的请求会被中断。')) return;
    $('#btnRestart').disabled = true;
    try {
      const res = await api('/api/restart', { method: 'POST' });
      toast(res.message || '正在重启', 'warn');
      markRestarting();
    } catch (error) {
      toast('重启失败: ' + error.message, 'err');
    } finally {
      $('#btnRestart').disabled = false;
    }
  }

  /* ---------- polling ---------- */

  let offlineSince = null;

  async function pollStatus() {
    try {
      const data = await api('/api/status');
      state.status = data;
      offlineSince = null;
      setConn(true, `已连接 · PID ${data.pid} · ${fmtUptime(data.uptimeSec)}`);
      $('#versionPill').textContent = 'v' + data.version;
      $('#serverMeta').textContent = `${data.host}:${data.port} · ${data.config.models} 个精确模型 · ${data.config.modelPatterns.length} 个通配模式`;
      if (currentView() === 'overview') renderOverview();
      if (currentView() === 'usage') { state.usage = data.usage; renderUsage(); }
      if (currentView() === 'codex') loadCodex();
      if (currentView() === 'config' && !state.configLoaded) loadConfig();
    } catch {
      if (offlineSince === null) offlineSince = Date.now();
      const restarting = offlineSince !== null && Date.now() - offlineSince < 15000;
      setConn(restarting ? null : false, restarting ? '服务重启中…' : '无法连接');
      $('#versionPill').textContent = 'v—';
      if (currentView() === 'overview') {
        $('#overviewCards').innerHTML = '<div class="card"><div class="label">服务状态</div><div class="value">离线</div><div class="sub">等待重连</div></div>';
      }
    }
  }

  async function pollUsage() {
    if (currentView() !== 'usage') return;
    try {
      const data = await api('/v1/usage?days=' + state.days);
      state.usage = data;
      renderUsage();
      $('#usageUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString();
    } catch {
      // 状态轮询会提示连接问题
    }
  }

  /* ---------- navigation ---------- */

  function currentView() {
    return (location.hash.slice(1) || 'overview').split('?')[0];
  }

  function navigate() {
    const view = currentView();
    $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    $('#pageTitle').textContent = VIEW_TITLES[view] || '总览';
    if (view === 'usage') pollUsage();
    if (view === 'codex') loadCodex();
    if (view === 'config') loadConfig();
  }

  function markRestarting() {
    setConn(null, '服务重启中…');
    setTimeout(() => pollStatus(), 1800);
  }

  /* ---------- init ---------- */

  $$('.nav-item').forEach((a) => a.addEventListener('click', navigate));
  $('#btnAuth').addEventListener('click', editAuthToken);
  $('#btnRefresh').addEventListener('click', () => {
    if (currentView() === 'config') loadConfig();
    else pollStatus();
  });
  $('#btnSave').addEventListener('click', saveConfig);
  $('#btnRestart').addEventListener('click', restartService);
  $('#btnRevert').addEventListener('click', () => { if (state.configLoaded) { state.configDirty = false; loadConfig(); } });
  $('#btnCodexApply').addEventListener('click', applyCodex);
  $('#btnCodexRestoreMarker').addEventListener('click', restoreCodexMarker);
  $('#configEditor').addEventListener('input', () => { state.configDirty = true; });
  $('#usageDays').addEventListener('change', (e) => { state.days = Number(e.target.value); pollUsage(); });

  window.addEventListener('hashchange', navigate);
  navigate();
  pollStatus();
  setInterval(pollStatus, 3000);
  setInterval(pollUsage, 10000);
})();
