/**
 * Collapse overlapping UI refreshes into one promise.
 *
 * The returned function is intentionally tiny so it can be shared by every
 * admin view without adding a framework or a scheduler dependency.
 */
export function createPollGate(task, { isPaused = () => false } = {}) {
  let pending = null;
  return (...args) => {
    if (isPaused()) return null;
    if (pending) return pending;
    const current = Promise.resolve().then(() => task(...args));
    pending = current.finally(() => {
      pending = null;
    });
    return pending;
  };
}
