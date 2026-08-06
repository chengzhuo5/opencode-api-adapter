/**
 * Codex Router 桌面壳（ewvjs + Windows WebView2）。
 *
 * 两种运行模式：
 * - 源码模式（npm start）：路由直接用仓库 config.json 在进程内启动；
 *   若 15722 已被 watchdog 占用，则只打开窗口，不重复启动。
 * - 打包模式（CodexRouter.exe + assets/）：按资源 manifest 升级 admin，
 *   首次运行写入模板与 config；路由数据（catalog、usage、logs、ctx-store）
 *   都在 %LOCALAPPDATA%\CodexRouter，随窗口关闭而停止。
 */
import { create_window, start } from 'ewvjs';
import { startRouter } from '../src/main.js';
import { seedDataDir } from './resourceSeed.js';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const isPackaged = Boolean(process.pkg);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(APP_DIR, '..');
const EXE_DIR = isPackaged ? path.dirname(process.execPath) : SOURCE_DIR;
const ASSETS_DIR = isPackaged ? path.join(EXE_DIR, 'assets') : null;
const DATA_DIR = isPackaged
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexRouter')
  : SOURCE_DIR;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPortOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function main() {
  let router = null;
  let configPath = path.join(SOURCE_DIR, 'config.json');
  let port = 15722;

  if (isPackaged) {
    configPath = seedDataDir({ assetsDir: ASSETS_DIR, dataDir: DATA_DIR });
    port = Number(readJson(configPath).port) || 15722;
    if (!(await isPortOpen(port))) {
      router = await startRouter({
        configPath,
        adminDir: path.join(DATA_DIR, 'admin'),
        catalogFile: path.join(DATA_DIR, 'catalog.json'),
        storeDir: path.join(DATA_DIR, 'ctx-store'),
        templateFile: path.join(DATA_DIR, 'catalog-template.json'),
        version: '0.2.0'
      });
    } else {
      console.log(`[desktop] router already listening on http://127.0.0.1:${port}`);
    }
  } else {
    port = fs.existsSync(configPath) ? (Number(readJson(configPath).port) || 15722) : 15722;
    if (!(await isPortOpen(port))) {
      router = await startRouter({ configPath });
    } else {
      console.log(`[desktop] router already listening on http://127.0.0.1:${port}`);
    }
  }

  const win = await create_window('Codex Router 控制台', `http://127.0.0.1:${port}/admin`, {
    width: 1280,
    height: 860,
    min_width: 1024,
    min_height: 700,
    background_color: '#f6f7fb',
    title_bar: true,
    debug: process.env.CODEX_ROUTER_DEBUG === '1'
  });

  win.on_close = () => {
    if (router) {
      console.log('[desktop] window closed, stopping router');
      router.stop().catch((error) => console.error('[desktop] stop failed:', error));
    }
  };

  win.run();
  start();
}

main().catch((error) => {
  console.error('[desktop] fatal:', error);
  process.exit(1);
});
