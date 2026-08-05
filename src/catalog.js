import { writeFileSync } from 'node:fs';
import { listRoutedModels, getModelEntry } from './routes.js';

export function buildCatalog(config, template, modelMeta) {
  const models = listRoutedModels(config)
    .map((id, index) => {
      // 上下文窗口优先级：模型生效配置（精确条目或通配符）> modelMeta.contextWindow > 模板默认
      const contextWindow = getModelEntry(config, id)?.contextWindow ?? modelMeta[id]?.contextWindow;
      return {
        ...template,
        context_window: contextWindow ?? template.context_window,
        max_context_window: contextWindow ?? template.max_context_window,
        slug: id,
        display_name: modelMeta[id]?.displayName || id,
        description: modelMeta[id]?.description || id,
        priority: 1000 + index,
        input_modalities: modelMeta[id]?.inputModalities || ['text']
      };
    });
  return { models };
}

export function writeCatalog(config, catalog) {
  writeFileSync(config.catalogFile, JSON.stringify(catalog, null, 2));
}
