import { createHash, timingSafeEqual } from 'node:crypto';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true;
  let normalized = String(host).trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function createManagementAccess(config) {
  const management = config?.management || {};
  const remoteListener = !isLoopbackHost(config?.host);
  const allowRemote = management.allowRemote === true;
  const token = typeof management.token === 'string' ? management.token : '';
  const trustedOrigins = new Set([
    ...defaultLoopbackOrigins(config?.port),
    ...(Array.isArray(management.trustedOrigins) ? management.trustedOrigins : [])
  ].map(normalizeOrigin).filter(Boolean));

  return {
    inspect(req, pathname) {
      if (!isManagementPath(pathname)) return null;
      const apiRequest = pathname === '/api' || pathname.startsWith('/api/');

      if (remoteListener && !allowRemote) {
        return deny(403, 'remote management is disabled');
      }

      if (apiRequest && remoteListener) {
        if (!token) return deny(503, 'remote management token is not configured');
        const provided = bearerToken(req.headers.authorization);
        if (!provided || !equalSecret(token, provided)) {
          return deny(401, 'management authorization required', {
            'www-authenticate': 'Bearer realm="CodexRouter"'
          });
        }
      }

      if (apiRequest && STATE_CHANGING_METHODS.has(req.method || '')) {
        const originHeader = req.headers.origin;
        if (originHeader !== undefined && !trustedOrigins.has(normalizeOrigin(originHeader))) {
          return deny(403, 'untrusted management origin');
        }
        const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          return deny(403, 'cross-site management request denied');
        }
      }

      return null;
    },
    summary() {
      return {
        allowRemote,
        remoteListener,
        tokenConfigured: Boolean(token),
        trustedOrigins: [...trustedOrigins]
      };
    }
  };
}

function isManagementPath(pathname) {
  return pathname === '/admin'
    || pathname.startsWith('/admin/')
    || pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/v1/usage'
    || pathname.startsWith('/v1/ctx/');
}

function defaultLoopbackOrigins(port) {
  const numericPort = Number(port);
  const suffix = Number.isInteger(numericPort) && numericPort > 0 ? `:${numericPort}` : '';
  return [
    `http://127.0.0.1${suffix}`,
    `http://localhost${suffix}`,
    `http://[::1]${suffix}`
  ];
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] || null;
}

function equalSecret(expected, provided) {
  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function deny(statusCode, message, headers = {}) {
  return { statusCode, message, headers };
}
