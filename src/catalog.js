import { writeFileSync } from 'node:fs';
import { listRoutedModels } from './routes.js';

export function buildCatalog(config, template, modelMeta) {
  const models = listRoutedModels(config)
    .map((id, index) => ({
      ...template,
      slug: id,
      display_name: modelMeta[id]?.displayName || id,
      description: modelMeta[id]?.description || id,
      priority: 1000 + index,
      input_modalities: modelMeta[id]?.inputModalities || ['text']
    }));
  return { models };
}

export function writeCatalog(config, catalog) {
  writeFileSync(config.catalogFile, JSON.stringify(catalog, null, 2));
}
