// modules/music/lavalink.js
// 役割: Lavalink(Shoukaku) 接続の確立・同期・掃除と、events.js へのイベントバインド委譲。
// ポイント:
// - ensureConnectionV4 に forceRejoin を追加（ゴースト接続やチャネル違いを強制再接続で解消）
// - shardId は実値を使用（0固定を回避）
// - validateState で「論理/実体の不一致」を広めに検出して掃除

import { useGlue } from './glue.js';
import { getState, cancelIdle } from './state.js';
import { sleep } from './utils.js';

// --- Player同期: Shoukakuのplayer実体をstate.connへ反映 ---
export function syncPlayer(gid) {
  const { shoukaku } = useGlue();
  const s = getState(gid);
  const p = shoukaku.players?.get(gid);
  if (p && s.conn !== p) s.conn = p;
  return s.conn;
}

// --- Voiceの実体確認（Guildの自分の在室状況） ---
async function getActualVoiceInfo(guild) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe();
    return { inVc: !!me?.voice?.channelId, channelId: me?.voice?.channelId || null };
  } catch {
    return { inVc: false, channelId: null };
  }
}

// --- 状態検証＆掃除（必要なら幽霊接続を破棄） ---
export async function validateState(gid, client) {
  const s = getState(gid);
  const guild = client.guilds.cache.get(gid);
  if (!guild) return { ok: false, reason: 'no-guild' };

  // Shoukaku実体と同期
  syncPlayer(gid);

  // 実際の接続状況
  const { inVc, channelId: actualChId } = await getActualVoiceInfo(guild);
  const logicalChId = s.conn?.channelId ?? null;

  // ケース分岐:
  // 1) 実体なしだが論理あり -> 幽霊: 破棄
  if (!inVc && logicalChId) {
    await leaveVoiceHard(gid).catch(() => {});
    s.conn = null;
    return { ok: true, player: null, actuallyConnected: false, fixed: 'ghost-cleared' };
  }

  // 2) 実体ありだが論理なし -> 再同期
  if (inVc && !logicalChId) {
    syncPlayer(gid);
    return { ok: true, player: s.conn ?? null, actuallyConnected: true, fixed: 'resynced' };
  }

  // 3) 実体と論理のチャネル不一致 -> 片方が古い; ここでは報告に留める（ensureで直す）
  if (inVc && logicalChId && logicalChId !== actualChId) {
    return { ok: true, player: s.conn ?? null, actuallyConnected: true, mismatch: true, logicalChId, actualChId };
  }

  return { ok: true, player: s.conn ?? null, actuallyConnected: inVc };
}

// --- イベントを一回だけバインド（本体は events.js から注入） ---
let _bind = () => {};
export function bindPlayerEventsOnce(gid, player) { _bind(gid, player); }
export function __setBind(fn) { _bind = fn; }

// --- 実退室（Manager経由が確実） ---
export async function leaveVoiceHard(gid) {
  const { shoukaku } = useGlue();
  try {
    await shoukaku.leaveVoiceChannel(gid);
  } catch {
    try { await getState(gid).conn?.leaveChannel?.(); } catch {}
  }
}

// --- 接続確立（V4想定） ---
// opts: { forceRejoin?: boolean }
export async function ensureConnectionV4(gid, channelId, opts = {}) {
  const { shoukaku } = useGlue();
  const s = getState(gid);
  const node = shoukaku.nodes.get('main') ?? [...shoukaku.nodes.values()][0];

  // 実 shardId を推定（単一シャードなら 0 になるはず）
  const client = useGlue().client;
  const shardId =
    client?.guilds?.cache?.get(gid)?.shardId ??
    client?.ws?.shards?.first?.()?.id ??
    0;

  // 既存同期
  let existing = shoukaku.players?.get(gid);
  if (existing && s.conn !== existing) s.conn = existing;

  const forceRejoin = !!opts.forceRejoin;
  
  // --- 物理的には既にそのVCに居る（player不整合だけ）→ 再joinしないで同期だけ ---
  if (!forceRejoin && !s.conn) {
    const client = useGlue().client;
    const guild = client.guilds.cache.get(gid);
    if (guild) {
      const { inVc, channelId: actualChId } = await getActualVoiceInfo(guild);
      if (inVc && actualChId === channelId) {
        const p = shoukaku.players?.get(gid);
        if (p) {
          s.conn = p;
          cancelIdle(gid);
          bindPlayerEventsOnce(gid, s.conn);
          return s.conn;
        }
      }
    }
  }

  // --- すでに同一VCならそのまま利用 ---
  if (!forceRejoin && s.conn && s.conn.channelId === channelId) {
    cancelIdle(gid);
    getState(gid).lastVcId = channelId;
    bindPlayerEventsOnce(gid, s.conn); // 実バインドは events.js 側が担当（WeakSetで多重防止）
    return s.conn;
  }

  // --- 異なるVC ／ ゴースト臭い ／ forceRejoin 指定：既存を掃除 ---
  if (s.conn) {
    try { await s.conn.leaveChannel(); } catch {}
    s.conn = null;
    await sleep(150);
  } else {
    // 例: 既存Player実体だけ残っているケース
    const ghost = shoukaku.players?.get(gid);
    if (ghost) {
      try { await ghost.leaveChannel(); } catch {}
      await sleep(150);
    }
  }

  // --- join（既存接続エラーの救済ルートも維持） ---
  try {
    s.conn = await shoukaku.joinVoiceChannel({
      guildId: gid,
      channelId,
      shardId,
      nodeName: node?.name ?? 'main',
      deaf: true,
      mute: false
    });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/existing connection|already connected/i.test(msg)) {
      try { await shoukaku.players?.get(gid)?.leaveChannel(); } catch {}
      await sleep(250);
      s.conn = await shoukaku.joinVoiceChannel({
        guildId: gid,
        channelId,
        shardId,
        nodeName: node?.name ?? 'main',
        deaf: true,
        mute: false
      });
    } else {
      throw e;
    }
  }

  try { await s.conn.setMute(false); } catch {}
  getState(gid).lastVcId = channelId;
  bindPlayerEventsOnce(gid, s.conn);
  cancelIdle(gid);
  return s.conn;
}
