// modules/music/locks.js
// 役割: ギルド単位の直列実行ロック。
// ポイント:
// - 先行タスクが失敗(reject)しても、後続が詰まらないように prev.catch(()=>{}) で回復
// - finally で自身の tail を消し、リーク/デッドロックを防止
// - 任意で timeoutMs を指定してハング検知（オプション）
// - 補助: isLocked / waitForIdle を提供

const guildLocks = new Map(); // gid -> Promise (tail)

export function isLocked(gid) {
  const p = guildLocks.get(gid);
  return !!p;
}

export async function waitForIdle(gid) {
  const tail = guildLocks.get(gid);
  if (tail) {
    try { await tail.catch(() => {}); } catch {}
  }
}

/**
 * ギルド単位で fn を直列実行する。
 * @template T
 * @param {string} gid
 * @param {() => (T | Promise<T>)} fn 実行したい処理
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export function runWithGuildLock(gid, fn, opts = {}) {
  const { timeoutMs = 0, label = '' } = opts;

  // 直前の tail を取得（無ければ解決済みの Promise）
  const prev = guildLocks.get(gid) ?? Promise.resolve();

  // 先行失敗でチェーンが崩れないよう、ここで回復させる
  const start = prev.catch(() => { /* swallow prior failure to keep the chain alive */ });

  // fn を実行するラッパ（timeout 付き）
  const run = async () => {
    const task = Promise.resolve().then(fn);
    if (!timeoutMs) return task;
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`[lock-timeout] ${label || gid}`)), timeoutMs)
    );
    return Promise.race([task, timeout]);
  };

  // 新しい tail を作成
  const p = start.then(run);

  // tail を登録し、完了時に自分自身なら解放
  guildLocks.set(gid, p.finally(() => {
    if (guildLocks.get(gid) === p) guildLocks.delete(gid);
  }));

  return p;
}
