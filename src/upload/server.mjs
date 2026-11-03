import http from 'node:http';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const maxBytes = 50_000_000;
const directory = '/srv/models';
const reply = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/upload') return reply(res, 404, { error: 'Not found.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { error: 'Use POST /upload?filename=part.glb with the raw file as the body.' });
  }
  const filename = url.searchParams.get('filename');
  if (!filename || filename.startsWith('.') || /[\\/:*?"<>|\x00-\x1f]/.test(filename) || /[. ]$/.test(filename) || Buffer.byteLength(filename) > 255) {
    req.resume();
    return reply(res, 400, { error: 'Provide a plain filename without a directory path.' });
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    return reply(res, 413, { error: 'File exceeds the 50 MB limit.' });
  }
  const temporary = join(directory, '.upload-' + randomUUID());
  let file;
  let bytes = 0;
  try {
    file = await open(temporary, 'wx');
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('File exceeds the 50 MB limit.');
        error.status = 413;
        throw error;
      }
      await file.writeFile(chunk);
    }
    await file.close();
    file = undefined;
    await rename(temporary, join(directory, filename));
    reply(res, 200, { filename, bytes, url: '/models/' + encodeURIComponent(filename) });
  } catch (error) {
    req.resume();
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (!error.status) console.error(error);
    if (!res.destroyed) reply(res, error.status || 500, { error: error.status ? error.message : 'Unable to save upload.' });
  }
});

server.listen(3000, '127.0.0.1');
