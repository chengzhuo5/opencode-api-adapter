export function logEvent(config, event) {
  const payload = {
    timestamp: new Date().toISOString(),
    component: 'codex-router',
    ...event
  };
  if (typeof config?.logger === 'function') {
    config.logger(payload);
    return;
  }
  console.warn(JSON.stringify(payload));
}
