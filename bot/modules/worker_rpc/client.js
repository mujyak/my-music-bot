// modules/worker_rpc/client.js
export function createRpcClient({ baseUrl, token, timeoutMs = 8000 }) {
  async function call(path, body, method = 'POST') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: ctrl.signal,
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        const msg = json?.error ?? `http ${res.status}`;
        throw new Error(msg);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    status: () => call('/status', null, 'GET'),
    play:   (p) => call('/rpc/music/play', p),
    skip:   (p) => call('/rpc/music/skip', p),
    leave:  (p) => call('/rpc/music/leave', p),
    queue:  (p) => call('/rpc/music/queue', p),
    loop:      (p) => call('/rpc/music/loop', p),
    loopQueue: (p) => call('/rpc/music/loop_queue', p),
    shuffle:   (p) => call('/rpc/music/shuffle', p),
  };
}
