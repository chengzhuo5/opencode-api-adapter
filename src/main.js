import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfig } from './config.js';
import { createRouter } from './server.js';
import { buildCatalog } from './catalog.js';
import { MODEL_META } from './modelMeta.js';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DRAIN_MS = 15_000;

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
  fetchImpl = undefined,
  log = console
} = {}) {
  let server = null;
  let activePrepared = null;
  const retiring = new Map();
  let restartQueue = Promise.resolve();
  const absoluteConfigPath = path.resolve(configPath);
  const pkgVersion = version
    ?? JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

  function prepareConfig(text = null) {
    const rawText = text ?? readFileSync(absoluteConfigPath, 'utf8');
    const raw = JSON.parse(rawText);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('config must be a JSON object');
    }
    const config = resolveConfig(raw, { env: process.env });
    validateRuntimeConfig(config);
    const catalogPath = catalogFile
      ?? (path.isAbsolute(config.catalogFile)
        ? config.catalogFile
        : path.resolve(rootDir, config.catalogFile));
    if (path.resolve(catalogPath) === absoluteConfigPath) {
      throw new Error('catalogFile must not point to the router config file');
    }
    const template = JSON.parse(readFileSync(
      templateFile ?? path.join(rootDir, 'catalog-template.json'),
      'utf8'
    ));
    const catalog = buildCatalog({ ...config, catalogFile: catalogPath }, template, MODEL_META);
    config.catalog = catalog;
    config.catalogFile = catalogPath;
    if (storeDir && config.compress) config.compress.storeDir = storeDir;
    return { config, catalog, catalogPath, text: rawText };
  }

  async function startServer(prepared) {
    const { config } = prepared;
    const s = createRouter(config, {
      fetchImpl,
      adminDir,
      version: pkgVersion,
      getConfigText: () => readFileSync(absoluteConfigPath, 'utf8'),
      onReloadValidate: (text) => {
        try {
          const candidate = prepareConfig(text);
          return { prepared: candidate, text };
        } catch (error) {
          return `配置校验失败: ${error.message}`;
        }
      },
      onReloadCommit: (validation) => replaceServer(
        validation?.prepared || prepareConfig(),
        validation?.text
      ),
      onRestartCommit: () => replaceServer(prepareConfig())
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          s.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          s.off('error', onError);
          log.log(`codex-opencode-go-router listening on http://${config.host}:${config.port}`);
          resolve();
        };
        s.once('error', onError);
        s.once('listening', onListening);
        s.listen(config.port, config.host);
      });
    } catch (error) {
      try { await s.__routerCleanup?.(); } catch { /* noop */ }
      throw error;
    }
    return s;
  }

  function beginDrain(s, forceAfterMs = DEFAULT_DRAIN_MS) {
    if (!s) return Promise.resolve();
    const existing = retiring.get(s);
    if (existing) return existing;
    const closeIdle = () => s.closeIdleConnections?.();
    const idleCloser = setInterval(closeIdle, 50);
    idleCloser.unref?.();
    const force = Number.isFinite(forceAfterMs) && forceAfterMs > 0
      ? setTimeout(() => s.closeAllConnections?.(), forceAfterMs)
      : null;
    force?.unref?.();
    const drain = new Promise((resolve) => {
      s.close(() => resolve());
      closeIdle();
    }).then(async () => {
      try { await s.__routerCleanup?.(); } catch { /* noop */ }
    }).finally(() => {
      clearInterval(idleCloser);
      if (force) clearTimeout(force);
    });
    retiring.set(s, drain);
    drain.finally(() => retiring.delete(s)).catch(() => {});
    return drain;
  }

  async function stopServer({ forceAfterMs = 15000 } = {}) {
    await restartQueue.catch(() => {});
    const targets = new Set(retiring.keys());
    if (server) targets.add(server);
    server = null;
    activePrepared = null;
    if (!targets.size) return;
    const drains = [...targets].map((target) => beginDrain(target, forceAfterMs));
    await Promise.allSettled(drains);
  }

  async function restartServer() {
    return replaceServer(prepareConfig());
  }

  function enqueueRestart(operation) {
    const result = restartQueue.then(operation, operation);
    restartQueue = result.catch(() => {});
    return result;
  }

  function replaceServer(prepared, persistText) {
    return enqueueRestart(async () => {
      const previousServer = server;
      const previousPrepared = activePrepared;
      const oldDrain = previousServer
        ? beginDrain(previousServer, previousPrepared?.config?.timeouts?.drainMs ?? DEFAULT_DRAIN_MS)
        : Promise.resolve();
      let nextServer = null;
      try {
        nextServer = await startServer(prepared);
        try {
          persistPrepared(prepared, persistText);
        } catch (error) {
          await beginDrain(nextServer);
          nextServer = null;
          throw error;
        }
        server = nextServer;
        activePrepared = {
          ...prepared,
          text: persistText ?? prepared.text
        };
        void oldDrain.catch(() => {});
      } catch (error) {
        if (nextServer) await beginDrain(nextServer);
        if (previousPrepared) {
          try {
            const rollbackServer = await startServer(previousPrepared);
            server = rollbackServer;
            activePrepared = previousPrepared;
          } catch (rollbackError) {
            server = null;
            activePrepared = null;
            throw new Error(
              `replacement failed (${error.message}); rollback failed (${rollbackError.message})`
            );
          }
        }
        throw error;
      }
    });
  }

  function persistPrepared(prepared, persistText) {
    const writes = [{
      file: prepared.catalogPath,
      content: JSON.stringify(prepared.catalog, null, 2)
    }];
    if (persistText !== undefined) {
      writes.push({
        file: absoluteConfigPath,
        content: persistText
      });
    }
    const snapshots = writes.map(({ file }) => ({
      file,
      content: existsSync(file) ? readFileSync(file) : null
    }));
    try {
      for (const write of writes) atomicWrite(write.file, write.content);
    } catch (error) {
      const restoreErrors = [];
      for (const snapshot of snapshots.reverse()) {
        try {
          if (snapshot.content === null) {
            if (existsSync(snapshot.file)) unlinkSync(snapshot.file);
          } else {
            atomicWrite(snapshot.file, snapshot.content);
          }
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
      }
      if (restoreErrors.length) {
        throw new Error(
          `persist failed (${error.message}); file rollback failed (${restoreErrors[0].message})`
        );
      }
      throw error;
    }
  }

  const initial = prepareConfig();
  persistPrepared(initial);
  server = await startServer(initial);
  activePrepared = initial;
  return {
    get server() { return server; },
    restart: restartServer,
    stop: stopServer
  };
}

function atomicWrite(file, content) {
  const target = path.resolve(file);
  const mode = existsSync(target) ? statSync(target).mode : undefined;
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, content, mode === undefined ? undefined : { mode });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* noop */ }
    }
  }
}

function validateRuntimeConfig(config) {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`invalid port: ${config.port}`);
  }
  if (typeof config.host !== 'string' || !config.host.trim()) {
    throw new Error('host must be a non-empty string');
  }
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
