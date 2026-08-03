import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createRouter } from './server.js';
import { buildCatalog, writeCatalog } from './catalog.js';
import { MODEL_META } from './modelMeta.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configIndex = process.argv.indexOf('--config');
const configPath = process.env.OPENCODE_ROUTER_CONFIG
  || (configIndex >= 0 ? process.argv[configIndex + 1] : 'config.json');
const config = loadConfig({ configPath });
const catalogFile = path.isAbsolute(config.catalogFile)
  ? config.catalogFile
  : path.resolve(rootDir, config.catalogFile);
const template = JSON.parse(readFileSync(path.join(rootDir, 'catalog-template.json'), 'utf8'));
const catalog = buildCatalog({ ...config, catalogFile }, template, MODEL_META);
writeCatalog({ ...config, catalogFile }, catalog);
config.catalog = catalog;

const server = createRouter(config);
server.listen(config.port, config.host, () => {
  console.log(`codex-opencode-go-router listening on http://${config.host}:${config.port}`);
});
