import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuth } from './auth.mjs';

const SESSION_COOKIE = 'model_session=';
const MAX_JSON_BYTES = 16384;
const LOGIN_WINDOW_MS = 15 * 60000;

/** Create a client-facing HTTP error. */
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Read a bounded JSON object from an account-management request. */
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw fail(415, 'Send application/json.');
  }

  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > MAX_JSON_BYTES) {
      throw fail(413, 'Request too large.');
    }
  }

  try {
    const value = JSON.parse(data);
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Expected an object.');
    }
    return value;
  } catch {
    throw fail(400, 'Invalid JSON object.');
  }
}

/** Keep account responses and model listings out of browser and proxy caches. */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/** Build the host-only browser cookie, or expire it when no token is supplied. */
function sessionCookie(token, secure) {
  const attributes = [
    SESSION_COOKIE + token,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${token ? 28800 : 0}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** Prefer an explicit Bearer token over a browser session cookie. */
function requestToken(req, bearer) {
  if (bearer) {
    return bearer.slice(7);
  }

  const cookie = req.headers.cookie
    ?.split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(SESSION_COOKIE));

  return cookie?.slice(SESSION_COOKIE.length) || '';
}

/** Reject cross-origin mutations; CLI Bearer clients do not need an Origin. */
function checkOrigin(req, url, origin, bearer) {
  if (['GET', 'HEAD'].includes(req.method)) {
    return;
  }
  if (req.headers.origin && req.headers.origin !== origin) {
    throw fail(403, 'Origin not allowed.');
  }

  const cookieMutation = !bearer && req.headers.cookie && url.pathname !== '/api/login';
  if (cookieMutation && req.headers.origin !== origin) {
    throw fail(403, 'Origin required.');
  }
}

/** Enforce a permission using current account roles; admins have every permission. */
function requireRole(user, role) {
  if (!user.roles.includes('admin') && !user.roles.includes(role)) {
    throw fail(403, 'Permission denied.');
  }
}

/** Index model files recursively, ignoring hidden entries and symlinks. */
async function listModels(directory, prefix = '') {
  const result = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      const children = await listModels(join(directory, entry.name), name + '/');
      result.push(...children);
    } else if (entry.isFile() && /\.(glb|gltf)$/i.test(name)) {
      result.push({ filename: name, url: '/?model=' + encodeURIComponent(name) });
    }
  }

  return result;
}

/** Bound login attempts and concurrent password hashing without trusting proxy IPs. */
function createLoginLimiter(auth) {
  const failures = new Map();
  let activeLogins = 0;

  /** Authenticate within the per-account attempt window and global hashing limit. */
  return async function login(username, password) {
    const now = Date.now();
    for (const [key, attempt] of failures) {
      if (attempt.until < now) {
        failures.delete(key);
      }
    }

    const key = username.toLowerCase();
    const attempt = failures.get(key) || { count: 0, until: now + LOGIN_WINDOW_MS };
    if (attempt.count >= 10 || failures.size >= 10000) {
      throw fail(429, 'Too many login attempts. Try later.');
    }

    attempt.count++;
    failures.set(key, attempt);
    if (activeLogins >= 4) {
      throw fail(429, 'Login busy. Try again shortly.');
    }

    let result;
    activeLogins++;
    try {
      result = await auth.login(username, password);
    } finally {
      activeLogins--;
    }

    failures.delete(key);
    return result;
  };
}

/** Create the local account API and authorization gate for the upload handler. */
export async function createApi({ directory, models, origin, secure = true, bootstrap }) {
  const auth = await createAuth(directory, bootstrap);
  const login = createLoginLimiter(auth);

  /** Clear the browser session after logout or account-wide token revocation. */
  function clearSession(res) {
    res.setHeader('Set-Cookie', sessionCookie('', secure));
    sendJson(res, 200, { ok: true });
  }

  /** Handle the two endpoints that do not require an authenticated account. */
  async function handlePublicRoute(req, res, url) {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const input = await readJson(req);
      const username = typeof input.username === 'string' ? input.username.slice(0, 64) : '';
      const result = await login(username, input.password);

      res.setHeader('Set-Cookie', sessionCookie(result.token, secure));
      sendJson(res, 200, result);
      return true;
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      clearSession(res);
      return true;
    }

    return false;
  }

  /** Dispatch authenticated account and listing requests after token validation. */
  async function handleAccountRoute(req, res, url, user) {
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case 'GET /api/me':
        sendJson(res, 200, { user });
        return;

      case 'GET /api/models': {
        requireRole(user, 'list-models');
        const index = await listModels(models);
        index.sort((first, second) => first.filename.localeCompare(second.filename));
        sendJson(res, 200, { models: index });
        return;
      }

      case 'POST /api/password': {
        const input = await readJson(req);
        await auth.changePassword(user.id, input.currentPassword, input.password);
        clearSession(res);
        return;
      }

      case 'POST /api/logout-all':
        // An empty account update increments the version without changing its fields.
        await auth.update(user.id, {});
        clearSession(res);
        return;

      case 'GET /api/users':
        requireRole(user, 'admin');
        sendJson(res, 200, { users: auth.list() });
        return;

      case 'POST /api/users': {
        requireRole(user, 'admin');
        const created = await auth.create(await readJson(req));
        sendJson(res, 201, { user: created });
        return;
      }
    }

    if (/^\/api\/users\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
      requireRole(user, 'admin');
      const id = url.pathname.split('/').pop();
      const updated = await auth.update(id, await readJson(req));
      sendJson(res, 200, { user: updated });
      return;
    }

    throw fail(404, 'Not found.');
  }

  /** Consume API requests, or return false to continue an authorized upload. */
  return async function handleRequest(req, res, url) {
    const isApi = url.pathname.startsWith('/api/');
    const isUpload = url.pathname === '/upload' && req.method === 'POST';
    if (!isApi && !isUpload) {
      return false;
    }

    try {
      const authorization = req.headers.authorization;
      const bearer = authorization?.startsWith('Bearer ') ? authorization : undefined;
      checkOrigin(req, url, origin, bearer);

      if (await handlePublicRoute(req, res, url)) {
        return true;
      }

      const user = await auth.verify(requestToken(req, bearer));
      if (isUpload) {
        requireRole(user, 'upload-models');
        return false;
      }

      await handleAccountRoute(req, res, url, user);
    } catch (error) {
      req.resume();
      if (!error.status) {
        console.error(error);
      }
      sendJson(res, error.status || 500, {
        error: error.status ? error.message : 'Request failed.',
      });
    }

    return true;
  };
}
