import { createApi } from './api.mjs';
import http from 'node:http';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Match the browser limit, but enforce it here even for direct API requests.
const MAX_UPLOAD_BYTES = 50_000_000;
const MODELS_DIRECTORY = process.env.MODELS_DIRECTORY || '/srv/models';
const api = await createApi({
  directory: process.env.AUTH_DIRECTORY || '/data/auth',
  models: MODELS_DIRECTORY,
  origin: process.env.APP_ORIGIN || 'http://localhost:8090',
  secure: process.env.COOKIE_SECURE !== 'false',
  bootstrap: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    passwordFile: process.env.ADMIN_PASSWORD_FILE,
  },
});

/** Send a JSON response from the upload service. */
function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Accept a single visible filename without paths or platform-specific separators. */
function isValidFilename(filename) {
  return (
    Boolean(filename) &&
    !filename.startsWith('.') &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(filename) &&
    !/[. ]$/.test(filename) &&
    Buffer.byteLength(filename) <= 255
  );
}

/** Authorize uploads before validating and atomically saving their raw file bytes. */
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    return reply(res, 200, { ok: true });
  }
  if (await api(req, res, url)) {
    return;
  }

  if (url.pathname !== '/upload') {
    return reply(res, 404, { error: 'Not found.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, {
      error: 'Use POST /upload?filename=part.glb with the raw file as the body.',
    });
  }

  const filename = url.searchParams.get('filename');
  if (!isValidFilename(filename)) {
    // Drain rejected bodies so the connection can still deliver the response.
    req.resume();
    return reply(res, 400, { error: 'Provide a plain filename without a directory path.' });
  }

  // Reject known oversized bodies before creating a temporary file.
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
    req.resume();
    return reply(res, 413, { error: 'File exceeds the 50 MB limit.' });
  }

  // Keep temporary and destination files on the same filesystem for rename.
  // Caddy hides these temporary filenames while an upload is in progress.
  const temporary = join(MODELS_DIRECTORY, '.upload-' + randomUUID());
  let file;
  let bytes = 0;
  try {
    file = await open(temporary, 'wx');

    // Count actual bytes as well: streamed requests may have no Content-Length.
    // Preserve the request on early exit so we can return a JSON 413 response.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        const error = new Error('File exceeds the 50 MB limit.');
        error.status = 413;
        throw error;
      }
      await file.writeFile(chunk);
    }

    await file.close();
    file = undefined;

    // Replace the destination only after the entire new file has been saved.
    await rename(temporary, join(MODELS_DIRECTORY, filename));
    reply(res, 200, {
      filename,
      bytes,
      url: '/models/' + encodeURIComponent(filename),
    });
  } catch (error) {
    req.resume();
    // Failed or interrupted uploads must not leave a partial public model.
    if (file) {
      await file.close().catch(() => {});
    }
    await unlink(temporary).catch(() => {});
    if (!error.status) {
      console.error(error);
    }
    if (!res.destroyed) {
      reply(res, error.status || 500, {
        error: error.status ? error.message : 'Unable to save upload.',
      });
    }
  }
}

const server = http.createServer(handleRequest);

// Only the Caddy process in this container should reach the upload handler.
server.listen(Number(process.env.API_PORT || 3000), '127.0.0.1');
