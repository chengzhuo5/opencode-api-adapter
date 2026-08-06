export class AdminApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.data = data;
  }
}

export function apiErrorMessage(data, status) {
  if (typeof data === 'string' && data.trim()) return data;
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) {
    return data.error.message;
  }
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  return `HTTP ${status}`;
}

export function createApiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getToken = () => '',
  timeoutMs = 15_000
} = {}) {
  return async function request(path, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers = new Headers(options.headers || {});
      const token = getToken();
      if (token && !headers.has('authorization')) {
        headers.set('authorization', `Bearer ${token}`);
      }
      const res = await fetchImpl(path, {
        ...options,
        signal: ctrl.signal,
        headers
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) throw new AdminApiError(apiErrorMessage(data, res.status), res.status, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
}
