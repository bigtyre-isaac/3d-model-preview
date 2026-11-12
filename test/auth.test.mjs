import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createAuth } from '../src/upload/auth.mjs';
import { createApi } from '../src/upload/api.mjs';
import { SignJWT } from 'jose';

const password = 'test-password-123456';

/** Allocate an isolated account/model directory and remove it after the test. */
async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('file accounts, permissions, revocation and persistence', async t => {
  const dir = await temporaryDirectory(t, 'model-auth-');
  const auth = await createAuth(dir, { password });
  const admin = await auth.login('admin', password);

  await assert.rejects(auth.update(admin.user.id, { disabled: true }), /one enabled admin/);
  await assert.rejects(auth.update(admin.user.id, { roles: [] }), /one enabled admin/);
  await assert.rejects(auth.login('admin', 'wrong'), /Invalid/);

  // Account creation rejects duplicate usernames and unsupported permissions.
  const user = await auth.create({ username: 'uploader', password, roles: ['upload-models'] });
  await assert.rejects(
    auth.create({ username: 'uploader', password, roles: [] }),
    /already exists/,
  );
  await assert.rejects(
    auth.create({ username: 'other', password, roles: ['unknown'] }),
    /Invalid roles/,
  );

  // Permission and password edits revoke tokens issued before the change.
  const login = await auth.login('uploader', password);
  assert.deepEqual((await auth.verify(login.token)).roles, ['upload-models']);
  await auth.update(user.id, { roles: ['list-models'] });
  await assert.rejects(auth.verify(login.token), /log in/);

  const next = await auth.login('uploader', password);
  await auth.changePassword(user.id, password, password + '-new');
  await assert.rejects(auth.verify(next.token));
  await assert.rejects(auth.login('uploader', password));

  // Existing credentials and signing material survive a restart.
  const restarted = await createAuth(dir);
  await restarted.login('admin', password);
  await restarted.login('uploader', password + '-new');
  const store = JSON.parse(await readFile(join(dir, 'users.json')));
  assert.ok(!JSON.stringify(store).includes(password));

  // A valid signature alone must not bypass audience or expiry checks.
  const key = Buffer.from(store.key, 'base64');
  for (const options of [
    { audience: 'wrong', expiry: '1h' },
    { audience: 'model-preview', expiry: -1 },
  ]) {
    const token = await new SignJWT({ version: 1 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(admin.user.id)
      .setIssuer('model-preview')
      .setAudience(options.audience)
      .setExpirationTime(options.expiry)
      .setIssuedAt()
      .sign(key);
    await assert.rejects(restarted.verify(token));
  }

  // A corrupt store must never trigger automatic account reinitialization.
  await writeFile(join(dir, 'users.json'), '{}');
  await assert.rejects(createAuth(dir, { password }), /Invalid account store/);
});
test('startup credentials reset only the configured admin and revoke its sessions', async t => {
  const dir = await temporaryDirectory(t, 'model-reset-');
  const auth = await createAuth(dir, { username: 'owner', password });
  const adminSession = await auth.login('owner', password);
  const uploader = await auth.create({
    username: 'uploader',
    password,
    roles: ['upload-models'],
  });
  const uploaderSession = await auth.login('uploader', password);
  const originalStore = JSON.parse(await readFile(join(dir, 'users.json')));

  const replacement = password + '-reset';
  const reset = await createAuth(dir, { username: 'owner', password: replacement });
  await assert.rejects(reset.login('owner', password));
  await reset.login('owner', replacement);
  await assert.rejects(reset.verify(adminSession.token));
  assert.equal((await reset.verify(uploaderSession.token)).id, uploader.id);

  const persisted = JSON.parse(await readFile(join(dir, 'users.json')));
  assert.equal(persisted.key, originalStore.key);
  assert.equal(persisted.users[0].id, adminSession.user.id);
  assert.deepEqual(persisted.users[1], originalStore.users[1]);
  await (await createAuth(dir)).login('owner', replacement);

  // A mounted secret overrides the environment password and tolerates a final newline.
  const secret = join(dir, 'admin-secret');
  await writeFile(secret, password + '-file\n');
  const fromFile = await createAuth(dir, {
    username: 'owner',
    password: replacement,
    passwordFile: secret,
  });
  const fileSession = await fromFile.login('owner', password + '-file');
  await assert.rejects(fromFile.login('owner', replacement));

  // Reapplying the same password still revokes sessions from the previous startup.
  const repeated = await createAuth(dir, { username: 'owner', passwordFile: secret });
  await assert.rejects(repeated.verify(fileSession.token));

  // Explicit invalid settings fail startup without modifying the account store.
  const beforeFailure = await readFile(join(dir, 'users.json'), 'utf8');
  await assert.rejects(createAuth(dir, { username: 'owner', password: 'short' }));
  await assert.rejects(createAuth(dir, { username: 'missing', password }), /enabled admin/);
  await assert.rejects(createAuth(dir, { username: 'uploader', password }), /enabled admin/);
  await assert.rejects(createAuth(dir, { passwordFile: join(dir, 'missing-secret') }));
  await writeFile(secret, '\n');
  await assert.rejects(createAuth(dir, { username: 'owner', passwordFile: secret }), /nonempty/);
  assert.equal(await readFile(join(dir, 'users.json'), 'utf8'), beforeFailure);
});

test('HTTP API enforces roles, cookie origin checks and Bearer uploads', async t => {
  const dir = await temporaryDirectory(t, 'model-api-');
  const models = join(dir, 'models');
  await mkdir(models);
  await writeFile(join(models, 'part.glb'), 'model');

  const origin = 'https://models.example.com';
  const api = await createApi({
    directory: join(dir, 'auth'),
    models,
    origin,
    bootstrap: { password },
  });
  const server = http.createServer(async (req, res) => {
    if (!(await api(req, res, new URL(req.url, origin)))) {
      res.writeHead(200);
      res.end('public or authorized upload');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Send JSON with optional Bearer credentials or browser request headers. */
  async function request(path, { method = 'GET', data, token, headers = {} } = {}) {
    return fetch(base + path, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /** Assert a status while returning the response for any additional checks. */
  async function expectStatus(path, status, options) {
    const response = await request(path, options);
    assert.equal(response.status, status);
    return response;
  }

  // Public model access is separate from the protected listing API.
  await expectStatus('/models/part.glb', 200);
  await expectStatus('/api/models', 401);

  // Browser sessions require safe cookie attributes and an exact mutation origin.
  const login = await expectStatus('/api/login', 200, {
    method: 'POST',
    data: { username: 'admin', password },
  });
  const { token } = await login.json();
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);

  const cookieHeaders = { Cookie: cookie.split(';')[0] };
  await expectStatus('/upload', 403, { method: 'POST', headers: cookieHeaders });
  await expectStatus('/upload', 200, {
    method: 'POST',
    headers: { ...cookieHeaders, Origin: origin },
  });
  await expectStatus('/upload', 403, {
    method: 'POST',
    token,
    headers: { Origin: 'https://evil.example' },
  });

  // Listing, uploading, and account management are independent permissions.
  const accounts = [
    { username: 'lister', roles: ['list-models'] },
    { username: 'uploader', roles: ['upload-models'] },
    { username: 'empty', roles: [] },
  ];
  for (const { username, roles } of accounts) {
    await expectStatus('/api/users', 201, {
      method: 'POST',
      data: { username, roles, password },
      token,
    });
    const userLogin = await expectStatus('/api/login', 200, {
      method: 'POST',
      data: { username, password },
    });
    const { token: userToken } = await userLogin.json();

    await expectStatus('/api/models', roles.includes('list-models') ? 200 : 403, {
      token: userToken,
    });
    await expectStatus('/upload', roles.includes('upload-models') ? 200 : 403, {
      method: 'POST',
      token: userToken,
    });
    await expectStatus('/api/users', 403, { token: userToken });
  }

  const listing = await expectStatus('/api/models', 200, { token });
  const result = await listing.json();
  assert.equal(result.models[0].filename, 'part.glb');

  // Account-wide logout must invalidate the Bearer token as well as the cookie.
  await expectStatus('/api/logout-all', 200, { method: 'POST', data: {}, token });
  await expectStatus('/api/me', 401, { token });

  // Failed credentials eventually hit the per-account login limit.
  const invalidLogin = { method: 'POST', data: { username: 'missing', password } };
  for (let i = 0; i < 10; i++) {
    await expectStatus('/api/login', 401, invalidLogin);
  }
  await expectStatus('/api/login', 429, invalidLogin);
});
test('actual upload server preserves public files, validates uploads and hides partial writes', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = await temporaryDirectory(t, 'model-server-');
  const models = join(dir, 'models');
  await mkdir(models);

  // Reserve an available local port before launching the actual upload service.
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  const child = spawn(process.execPath, ['src/upload/server.mjs'], {
    env: {
      ...process.env,
      AUTH_DIRECTORY: join(dir, 'auth'),
      MODELS_DIRECTORY: models,
      API_PORT: String(port),
      ADMIN_PASSWORD: password,
      COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', data => {
    output += data;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  // Poll readiness instead of assuming how quickly password hashing will finish.
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(output);
    }
    try {
      ready = (await fetch(base + '/health')).ok;
    } catch {
      // The loopback listener may not be open yet.
    }
    if (ready) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, output);

  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  const { token } = await login.json();

  /** Exercise the raw-byte upload endpoint with or without authentication. */
  async function upload(filename, data, authenticated = true) {
    return fetch(base + '/upload?filename=' + encodeURIComponent(filename), {
      method: 'POST',
      headers: authenticated ? { Authorization: 'Bearer ' + token } : {},
      body: data,
    });
  }

  // Rejected requests must not create public files.
  assert.equal((await upload('part.glb', 'denied', false)).status, 401);
  assert.equal((await upload('../bad.glb', 'bad')).status, 400);

  // Completed uploads replace existing content only after saving succeeds.
  assert.equal((await upload('part.glb', 'first')).status, 200);
  assert.equal(await readFile(join(models, 'part.glb'), 'utf8'), 'first');
  assert.equal((await upload('part.glb', 'replacement')).status, 200);
  assert.equal(await readFile(join(models, 'part.glb'), 'utf8'), 'replacement');

  // Oversized requests leave neither a destination nor temporary upload files.
  assert.equal((await upload('large.glb', Buffer.alloc(50_000_001))).status, 413);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(models), ['part.glb']);
});
