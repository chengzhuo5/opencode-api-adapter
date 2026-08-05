import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex config.toml 动态配置管理器（零依赖、行级编辑）。
 *
 * 目标：只新增 minar_route provider 并替换顶层 model_provider/model，
 * 其余用户配置一律不动；每次修改前按时间戳备份；还原时优先恢复
 * 注释掉的原始字段，失败才提示用户从备份文件还原。
 *
 * 安全约束：
 * - 只认顶层（表头出现前）的 model_provider / model；
 * - 替换用专用注释标记 `# minar_route_original: ...`，与用户自己的注释区分；
 * - 日志/API 不返回文件原文，避免泄露 experimental_bearer_token 等敏感值。
 */

const DEFAULT = {
  enabled: false,
  configPath: path.join(os.homedir(), '.codex', 'config.toml'),
  providerName: 'minar_route',
  providerDisplayName: '米纳尔',
  model: 'gpt-5.6-luna',
  baseUrl: 'http://127.0.0.1:15722/v1',
  wireApi: 'responses',
  authToken: 'PROXY_MANAGED'
};

const MARKER = '# minar_route_original: ';
const BACKUP_SUFFIX = '.minar_route.bak';

const PROVIDER_FIELDS = [
  ['name', (c) => JSON.stringify(c.providerDisplayName)],
  ['base_url', (c) => JSON.stringify(c.baseUrl)],
  ['wire_api', (c) => JSON.stringify(c.wireApi)],
  ['requires_openai_auth', () => 'true'],
  ['experimental_bearer_token', (c) => JSON.stringify(c.authToken)]
];

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds())}`;
}

function splitLines(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return { lines: content.split(/\r?\n/), eol };
}

function isTableHeader(line) {
  const t = line.trim();
  return /^\[\[?/.test(t) && /\]\]?$/.test(t);
}

function parseTopLevelFields(lines) {
  const out = {};
  let inTable = false;
  for (const line of lines) {
    if (isTableHeader(line)) { inTable = true; continue; }
    if (inTable) continue;
    const m = line.match(/^\s*(model_provider|model)\s*=\s*(.*)$/);
    if (m && !out[m[1]]) out[m[1]] = m[2].trim();
  }
  return out;
}

function findMarkers(lines) {
  const out = {};
  for (const line of lines) {
    const m = line.match(new RegExp(`^${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(model_provider|model)\\s*=\\s*(.*)$`));
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function providerBlockRange(lines, providerName) {
  const header = `[model_providers.${providerName}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isTableHeader(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function setProviderField(lines, block, key, value) {
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  for (let i = block.start + 1; i < block.end; i++) {
    if (re.test(lines[i])) {
      const indent = lines[i].match(/^\s*/)[0];
      lines[i] = `${indent}${key} = ${value}`;
      return;
    }
  }
  // 块内没有该字段（含注释形式）→ 追加到块尾
  lines.splice(block.end, 0, `${key} = ${value}`);
  block.end += 1;
}

export function createCodexManager(cfg = {}) {
  const c = { ...DEFAULT, ...(cfg?.codex || {}) };
  const configPath = c.configPath;

  function listBackups() {
    if (!fs.existsSync(configPath)) return [];
    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + '.') && f.endsWith(BACKUP_SUFFIX))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { file: full, name: f, mtime: st.mtime.toISOString(), size: st.size };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  function backup() {
    let target = `${configPath}.${nowStamp()}${BACKUP_SUFFIX}`;
    let n = 1;
    while (fs.existsSync(target)) {
      target = `${configPath}.${nowStamp()}-${n}${BACKUP_SUFFIX}`;
      n += 1;
    }
    fs.copyFileSync(configPath, target);
    return target;
  }

  function status() {
    if (!fs.existsSync(configPath)) {
      return { exists: false, configPath, backups: [] };
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const { lines } = splitLines(content);
    const active = parseTopLevelFields(lines);
    const markers = findMarkers(lines);
    const block = providerBlockRange(lines, c.providerName);
    let blockName = null;
    let blockFields = {};
    if (block) {
      for (let i = block.start + 1; i < block.end; i++) {
        const m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m) blockFields[m[1]] = m[2].trim();
      }
      blockName = blockFields.name;
    }
    return {
      exists: true,
      configPath,
      applied: active.model_provider === JSON.stringify(c.providerName),
      activeModelProvider: active.model_provider || null,
      activeModel: active.model || null,
      originalModelProvider: markers.model_provider || null,
      originalModel: markers.model || null,
      provider: {
        name: c.providerName,
        displayName: c.providerDisplayName,
        model: c.model,
        blockExists: Boolean(block),
        blockName,
        baseUrl: blockFields.base_url || null
      },
      modelCatalogJsonPresent: lines.some((l) => /^\s*model_catalog_json\s*=/.test(l)),
      backups: listBackups()
    };
  }

  function apply() {
    if (!fs.existsSync(configPath)) {
      const err = new Error(`config.toml 不存在: ${configPath}`);
      err.statusCode = 400;
      throw err;
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const { lines, eol } = splitLines(content);
    let changed = false;
    let inTable = false;

    // 1. 顶层 model_provider / model：注释原值 + 插入新值（标记可还原）
    const topKeys = [
      ['model_provider', JSON.stringify(c.providerName)],
      ['model', JSON.stringify(c.model)]
    ];
    for (let i = 0; i < lines.length; i++) {
      if (isTableHeader(lines[i])) { inTable = true; continue; }
      if (inTable) continue;
      for (const [key, newValue] of topKeys) {
        const m = lines[i].match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
        if (!m) continue;
        if (m[1].trim() === newValue) {
          // 已经是目标值；若已有标记则不动，避免重复注释
          if (findMarkers(lines)[key]) continue;
          // 用户手动设置的目标值，无标记可还原 → 补一个标记指向当前值
          lines[i] = `${MARKER}${key} = ${m[1].trim()}`;
          lines.splice(i + 1, 0, `${key} = ${newValue}`);
          changed = true;
          i += 1;
          continue;
        }
        lines[i] = `${MARKER}${key} = ${m[1].trim()}`;
        lines.splice(i + 1, 0, `${key} = ${newValue}`);
        changed = true;
        i += 1;
      }
    }

    // 2. minar_route provider 块：不存在则追加，存在则补齐/更新字段
    let block = providerBlockRange(lines, c.providerName);
    if (!block) {
      const append = [
        `[model_providers.${c.providerName}]`,
        ...PROVIDER_FIELDS.map(([key, fn]) => `${key} = ${fn(c)}`)
      ];
      if (lines.length && lines[lines.length - 1].trim() !== '') append.unshift('');
      lines.push(...append);
      changed = true;
    } else {
      for (const [key, fn] of PROVIDER_FIELDS) {
        const before = lines.slice(block.start, block.end).join('\n');
        setProviderField(lines, block, key, fn(c));
        if (lines.slice(block.start, block.end).join('\n') !== before) changed = true;
      }
    }

    if (!changed) {
      return { changed: false, status: status() };
    }
    const backupFile = backup();
    fs.writeFileSync(configPath, lines.join(eol), 'utf8');
    return { changed: true, backup: backupFile, status: status() };
  }

  function restore({ file, confirm = false } = {}) {
    if (!fs.existsSync(configPath)) {
      const err = new Error(`config.toml 不存在: ${configPath}`);
      err.statusCode = 400;
      throw err;
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const { lines, eol } = splitLines(content);
    const markers = findMarkers(lines);

    if (markers.model_provider && markers.model) {
      // 优先：按注释字段还原（移除新值行 + 取消注释原值 + 删除我们加的 provider 块）
      const out = [];
      let inTable = false;
      let removedBlock = false;
      let blockKept = null;
      const block = providerBlockRange(lines, c.providerName);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (block && i >= block.start && i < block.end) {
          if (i === block.start) removedBlock = true;
          continue;
        }
        if (isTableHeader(line)) { inTable = true; out.push(line); continue; }
        if (inTable) { out.push(line); continue; }
        const marker = line.match(new RegExp(`^${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(model_provider|model)\\s*=\\s*(.*)$`));
        if (marker) {
          out.push(`${marker[1]} = ${marker[2].trim()}`);
          continue;
        }
        const active = line.match(/^\s*(model_provider|model)\s*=\s*(.*)$/);
        if (active) {
          // 移除我们写入的顶层新值（原值已由标记恢复）
          continue;
        }
        out.push(line);
      }
      if (block && !removedBlock) blockKept = 'provider block not removed';
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      const backupFile = backup();
      fs.writeFileSync(configPath, out.join(eol), 'utf8');
      return { restored: true, method: 'marker', backup: backupFile, warning: blockKept, status: status() };
    }

    // 标记缺失：必须由用户确认后从备份还原
    const backups = listBackups();
    if (!file || !confirm) {
      return { restored: false, needsBackup: true, backups };
    }
    const resolved = path.resolve(file);
    const valid = backups.some((b) => b.file === resolved);
    if (!valid || !fs.existsSync(resolved)) {
      const err = new Error('备份文件不在已知列表或不存在');
      err.statusCode = 400;
      throw err;
    }
    const snapshot = backup(); // 还原前也留一份当前状态
    fs.copyFileSync(resolved, configPath);
    return { restored: true, method: 'backup', backup: snapshot, from: resolved, status: status() };
  }

  return { status, apply, restore, listBackups };
}
