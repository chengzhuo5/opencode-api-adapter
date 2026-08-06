/**
 * 打包前把路由运行所需资源复制到 desktop/assets：
 * - admin/（管理页面）
 * - catalog-template.json（catalog 模板）
 * - config.example.json（参考配置）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.resolve(DESKTOP_DIR, '..');
const ASSETS_DIR = path.join(DESKTOP_DIR, 'assets');

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

fs.mkdirSync(ASSETS_DIR, { recursive: true });
copyDir(path.join(SOURCE_DIR, 'admin'), path.join(ASSETS_DIR, 'admin'));
fs.copyFileSync(path.join(SOURCE_DIR, 'catalog-template.json'), path.join(ASSETS_DIR, 'catalog-template.json'));
fs.copyFileSync(path.join(SOURCE_DIR, 'config.example.json'), path.join(ASSETS_DIR, 'config.example.json'));
const packageVersion = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'package.json'), 'utf8')).version;
const files = {};
for (const file of listFiles(ASSETS_DIR)) {
  const relative = path.relative(ASSETS_DIR, file).replaceAll(path.sep, '/');
  if (relative === 'asset-manifest.json') continue;
  files[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
fs.writeFileSync(path.join(ASSETS_DIR, 'asset-manifest.json'), JSON.stringify({
  schemaVersion: 1,
  packageVersion,
  files
}, null, 2));
console.log('[prep] assets ready:', ASSETS_DIR);

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(file));
    else files.push(file);
  }
  return files.sort();
}
