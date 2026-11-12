// Run inside the built image with this file mounted at /smoke.mjs.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Use disposable container storage so these checks cannot alter deployment accounts.
await writeFile('/srv/models/smoke.glb', 'model bytes');
const child = spawn('/bin/bash', ['/app/start.sh'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ADMIN_PASSWORD: 'container-test-password',
    APP_ORIGIN: 'http://localhost',
    COOKIE_SECURE: 'false',
  },
});

try {
  // Both supervised processes must be ready before exercising proxy routes.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready =
        (await fetch('http://127.0.0.1:3000/health')).ok && (await fetch('http://127.0.0.1/')).ok;
    } catch {
      // Caddy or Node may still be starting.
    }
    if (ready) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'container starts');

  // Public models are downloadable data; protected listings still require login.
  const model = await fetch('http://127.0.0.1/models/smoke.glb');
  assert.equal(model.status, 200);
  assert.equal(model.headers.get('content-disposition'), 'attachment');
  assert.equal(model.headers.get('content-security-policy'), 'sandbox');
  assert.equal((await fetch('http://127.0.0.1/account')).status, 200);
  assert.equal((await fetch('http://127.0.0.1/upload.html')).status, 200);
  assert.equal((await fetch('http://127.0.0.1/api/models')).status, 401);

  // Exercise authentication and upload through Caddy rather than calling Node directly.
  const login = await fetch('http://127.0.0.1/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'container-test-password' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch('http://127.0.0.1/api/models', { headers })).status, 200);
  assert.equal(
    (
      await fetch('http://127.0.0.1/upload?filename=uploaded.glb', {
        method: 'POST',
        headers,
        body: 'uploaded model',
      })
    ).status,
    200,
  );
  assert.equal(
    await (await fetch('http://127.0.0.1/models/uploaded.glb')).text(),
    'uploaded model',
  );

  // In-progress uploads must never become publicly readable.
  await writeFile('/srv/models/.upload-private', 'hidden');
  assert.equal((await fetch('http://127.0.0.1/models/.upload-private')).status, 404);
  console.log('Container smoke checks passed.');
} finally {
  child.kill('SIGTERM');
}
