// modules/music/state.js

// ループ状態は文字列で固定（他所で toString 済み前提）
export const LOOP = Object.freeze({ off: 'off', track: 'track', queue: 'queue' });

/**
 * ギルドごとの再生状態（ランタイムのみ保持）
 * 注意:
 * - selfLeaveUntil は /leave 直後の誤爆抑止ウィンドウ。resetState() では消さない。
 * - idleTimer は setIdle()/cancelIdle() でのみ操作すること。
 */
const DEFAULT = () => ({
  conn: null,                 // Shoukaku Player 実体
  queue: [],                  // 待ち行列（Lavalink track配列）
  current: null,              // 再生中トラック
  loop: LOOP.off,             // off | track | queue
  playing: false,             // 再生フラグ
  idleTimer: null,            // setTimeout のハンドル
  lastTextChannelId: null,    // 直近のスラッシュ実行テキストCH（将来拡張用）
  lastVcId: null,
  selfLeaveUntil: 0           // /leave等の直後に通知/idle予約を抑止する期限のepoch(ms)
});

const states = new Map(); // gid -> state

export function getState(gid) {
  if (!states.has(gid)) states.set(gid, DEFAULT());
  return states.get(gid);
}

/**
 * 再生状態を初期化。
 * 重要: selfLeaveUntil は残す（/leave 直後の抑止ウィンドウを維持するため）。
 */
export function resetState(gid) {
  const s = getState(gid);
  s.conn = null;
  s.queue = [];
  s.current = null;
  s.playing = false;
  s.loop = LOOP.off;
  cancelIdle(gid);
  s.lastVcId = null;
  // s.selfLeaveUntil は消さない
}

/** アイドル退室の予約をキャンセル */
export function cancelIdle(gid) {
  const s = getState(gid);
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
}

/**
 * アイドル退室を予約。
 * - 既存予約は必ず cancelIdle() で解除した上で新規に張る。
 * - 発火時に idleTimer を自動で null 化。
 * - Nodeの終了を妨げないように .unref() する（利用環境が対応していれば）。
 */
export function setIdle(gid, handler, ms) {
  cancelIdle(gid);
  const s = getState(gid);
  const wrapped = async () => {
    s.idleTimer = null; // 発火時にクリア
    try { await handler(); } catch (_) { /* 落とさない */ }
  };
  const t = setTimeout(wrapped, ms);
  if (typeof t.unref === 'function') {
    // DockerやCLI終了時にタイマーだけでプロセスが残らないように
    t.unref();
  }
  s.idleTimer = t;
}
