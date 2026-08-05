/**
 * 打包前把路由运行所需资源复制到 desktop/assets：
 * - admin/（管理页面）
 * - catalog-template.json（catalog 模板）
 * - config.example.json（参考配置）
 */
import fs from 'node:fs';
import path from 'node:path';
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
console.log('[prep] assets ready:', ASSETS_DIR);
