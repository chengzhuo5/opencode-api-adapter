import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createRouter } from './server.js';
import { buildCatalog, writeCatalog } from './catalog.js';
import { MODEL_META } from './modelMeta.js';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 启动路由服务。CLI 与桌面壳共用同一入口：
 * - CLI：`node src/main.js [--config path]`；
 * - 桌面壳：import { startRouter } 在进程内启动，热重启/优雅停止复用同一套逻辑。
 */
export async function startRouter({
  configPath = 'config.json',
  rootDir = moduleRoot,
  adminDir = path.resolve(moduleRoot, 'admin'),
  catalogFile = null,
  storeDir = null,
  templateFile = null,
  version = null,
  log = console
} = {}) {
  let server = null;
  const pkgVersion = version
    ?? JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

  function loadAndBuild() {
    const config = loadConfig({ configPath });
    const catalogPath = catalogFile
      ?? (path.isAbsolute(config.catalogFile)
        ? config.catalogFile
        : path.resolve(rootDir, config.catalogFile));
    const template = JSON.parse(readFileSync(
      templateFile ?? path.join(rootDir, 'catalog-template.json'),
      'utf8'
    ));
    const catalog = buildCatalog({ ...config, catalogFile: catalogPath }, template, MODEL_META);
    writeCatalog({ ...config, catalogFile: catalogPath }, catalog);
    config.catalog = catalog;
    config.catalogFile = catalogPath;
    if (storeDir && config.compress) config.compress.storeDir = storeDir;
    return config;
  }

  function startServer(config) {
    const s = createRouter(config, {
      adminDir,
      version: pkgVersion,
      getConfigText: () => readFileSync(configPath, 'utf8'),
      onReloadValidate: (text) => {
        try {
          JSON.parse(text);
        } catch (error) {
          return `配置不是合法 JSON: ${error.message}`;
        }
        writeFileSync(configPath, text, 'utf8');
        return null;
      },
      onReloadCommit: restartServer,
      onRestartCommit: restartServer
    });
    s.listen(config.port, config.host, () => {
      log.log(`codex-opencode-go-router listening on http://${config.host}:${config.port}`);
    });
    return s;
  }

  async function stopServer() {
    if (!server) return;
    const s = server;
    server = null;
    try { s.__routerCleanup?.(); } catch { /* noop */ }
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  async function restartServer() {
    const next = loadAndBuild();
    await stopServer();
    server = startServer(next);
  }

  server = startServer(loadAndBuild());
  return {
    get server() { return server; },
    restart: restartServer,
    stop: stopServer
  };
}

// CLI 入口
const configIndex = process.argv.indexOf('--config');
const cliConfigPath = process.env.OPENCODE_ROUTER_CONFIG
  || (configIndex >= 0 ? process.argv[configIndex + 1] : 'config.json');
const isCli = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  startRouter({ configPath: cliConfigPath })
    .then((router) => {
      process.on('SIGTERM', async () => {
        await router.stop();
        process.exit(0);
      });
      // Windows 服务（NSSM）停止时发送 Ctrl+C，Node 收到 SIGINT
      process.on('SIGINT', async () => {
        await router.stop();
        process.exit(0);
      });
    })
    .catch((error) => {
      console.error('router failed to start:', error);
      process.exit(1);
    });
}
