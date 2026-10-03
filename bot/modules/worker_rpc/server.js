// modules/worker_rpc/server.js
import http from 'node:http';
import { URL } from 'node:url';

const MAX_BODY = 1_000_000; // 1MB

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > MAX_BODY) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid json')); }
    });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function startWorkerRpcServer({ port, token, getStatus, handlers }) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);

      // health check
      if (u.pathname === '/healthz') return send(res, 200, { ok: true });

      // status (GET)
      if (u.pathname === '/status') {
        const auth = req.headers.authorization ?? '';
        if (token && auth !== `Bearer ${token}`) return send(res, 401, { ok: false, error: 'unauthorized' });
        const status = await getStatus();
        return send(res, 200, { ok: true, status });
      }

      // rpc (POST)
      const auth = req.headers.authorization ?? '';
      if (token && auth !== `Bearer ${token}`) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });

      const body = await readJson(req);
      const handler = handlers[u.pathname];
      if (!handler) return send(res, 404, { ok: false, error: 'not found' });

      const result = await handler(body);
      return send(res, 200, { ok: true, result: result ?? {} });
    } catch (e) {
      return send(res, 500, { ok: false, error: e?.message ?? 'internal error' });
    }
  });

  server.listen(port, () => console.log(`[worker-rpc] listening :${port}`));
  return server;
}
