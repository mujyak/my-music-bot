// modules/music/service.js
import { useGlue } from './glue.js';
import { LOOP, getState, resetState, cancelIdle, setIdle } from './state.js';
import { ensureConnectionV4 } from './lavalink.js';
import { toArray, buildIdentifier } from './utils.js';

// 環境値（glueから）
const AUTO_LEAVE_MS = 3 * 60 * 1000;

// いま Bot が特定VCに居るかを即時判定
async function isInSameVc(gid, vcId) {
  const { client } = useGlue();
  const guild = client.guilds.cache.get(gid) ?? await client.guilds.fetch(gid).catch(() => null);
  const me = guild?.members?.me ?? (guild ? await guild.members.fetchMe().catch(() => null) : null);
  return !!(me?.voice?.channelId && me.voice.channelId === vcId);
}

// --- 内部ユーティリティ: 現在のVCにだけメッセージを出す（出せなければ黙る） ---
async function sendToCurrentVc(gid, content) {
  const { client, sendToChannel } = useGlue();
  const guild = client.guilds.cache.get(gid) ?? await client.guilds.fetch(gid).catch(() => null);
  const me = guild?.members?.me ?? (guild ? await guild.members.fetchMe().catch(() => null) : null);
  const vcId = me?.voice?.channelId || null;
  if (!vcId) return false;
  return sendToChannel(gid, vcId, content);
}

export async function resolveYouTube(identifierOrQuery) {
  const { shoukaku, debugResolve } = useGlue();
  const node = shoukaku.nodes.get('main') ?? [...shoukaku.nodes.values()][0];
  const identifier = buildIdentifier(identifierOrQuery);
  let res;
  try {
    res = await node.rest.resolve(identifier);
  } catch (e) {
    console.error('[resolve]', e?.message || e);
    return { tracks: [], playlist: false, loadType: 'error', message: e?.message };
  }
  const loadType = res?.loadType ?? res?.type ?? null;
  const raw = res?.data ?? res?.tracks ?? [];
  const arr = toArray(raw);
  if (debugResolve) console.log(`[resolve] ${loadType} x${arr.length}`);
  if (!res || loadType === 'empty' || arr.length === 0) {
    return { tracks: [], playlist: false, loadType: 'empty' };
  }
  if (loadType === 'error') {
    return { tracks: [], playlist: false, loadType: 'error', message: res?.data?.message };
  }
  switch (loadType) {
    case 'track':   return { tracks: arr.slice(0, 1), playlist: false, loadType };
    case 'search':  return { tracks: arr.slice(0, 1), playlist: false, loadType };
    case 'playlist':return { tracks: arr.slice(0, 1), playlist: true,  loadType }; // 単発運用
    default:        return { tracks: arr.slice(0, 1), playlist: false, loadType };
  }
}

export async function playNext(gid) {
  const s = getState(gid);
  if (s.playing) return;

  // エンコード欠落は安全スキップ
  let next = s.queue.shift();
  while (next && !next?.encoded) {
    console.warn('[playNext] missing encoded; skipping broken track');
    next = s.queue.shift();
  }
  if (!next) return;

  s.current = next;
  s.playing = true;
  cancelIdle(gid);

  // 再生開始通知は「VCに送れた時だけ」
  const title = next.info?.title || '(unknown)';
  await sendToCurrentVc(gid, `▶ 再生開始: **${title}**`).catch(() => {});

  await s.conn.playTrack({ track: { encoded: next.encoded } });
}

export function scheduleIdle(gid, reason = 'idle') {
  const { client } = useGlue();
  setIdle(gid, async () => {
    // --- 発火直前の安全確認（レース潰し） ---
    const guild = client.guilds.cache.get(gid) ?? await client.guilds.fetch(gid).catch(() => null);
    const me = guild?.members?.me ?? (guild ? await guild.members.fetchMe().catch(() => null) : null);
    const inVcNow = !!me?.voice?.channelId;
    const s = getState(gid);
    const selfLeave = (s.selfLeaveUntil || 0) > Date.now();

    // 1) もうVCに居ない or 直近で自発的に退出した → 何もしないで終了
    if (!inVcNow || selfLeave) {
      console.log(`[auto-leave] skipped (inVc=${inVcNow}, self=${selfLeave}) gid=${gid} reason=${reason}`);
      return;
    }

    // 2) VCにだけ告知（送れなければ黙る）
    await sendToCurrentVc(gid, '🕒 再生終了後、3分間操作がなかったため退出しました（キューはクリア）。').catch(() => {});
    s.selfLeaveUntil = Date.now() + 10000;
    await leaveHardAndClear(gid);
    console.log(`[auto-leave] ${gid} (${reason}) after ${AUTO_LEAVE_MS}ms`);
  }, AUTO_LEAVE_MS);
}

export async function leaveHardAndClear(gid) {
  const { shoukaku } = useGlue();
  try {
    cancelIdle(gid);
    await shoukaku.leaveVoiceChannel(gid);
  } catch {
    try { await getState(gid).conn?.leaveChannel?.(); } catch {}
  } finally {
    resetState(gid);
  }
}

// === Slash command impls ===
export async function playCommand({ itx, q }) {
  const { maxQueue } = useGlue();
  const gid = itx.guildId;
  const st = getState(gid);
  st.lastTextChannelId = itx.channelId;

  // 1) VCを取得
  const vcId =
    itx.member?.voice?.channelId ||
    itx.guild?.voiceStates?.cache?.get(itx.user.id)?.channelId ||
    null;
  if (!vcId) return { ephemeral: true, content: '先にボイスチャンネルに参加してね！' };
  st.lastVcId = vcId;

  // 2) 接続
  await itx.deferReply();
  // 既に同じVCにいるなら ensure をスキップ（再joinで例外を踏まない）
  const alreadyIn = await isInSameVc(gid, vcId);
  if (!alreadyIn) {
    try {
      await ensureConnectionV4(gid, vcId);
    } catch (e) {
      console.error('[ensureConnectionV4]', e?.message || e);
      return { content: '接続に失敗しちゃった…もう一度試してみてね。' };
    }
  }

  // 3) 解決
  const resolved = await resolveYouTube(q.trim());
  const track = resolved?.tracks?.[0];
  if (!track?.encoded) return { content: '見つからなかった…' };

  // 4) キュー入れ
  const s = getState(gid);
  if (s.queue.length >= maxQueue) return { content: `これ以上は入らないよ（上限${maxQueue}）` };
  s.queue.push(track);

  if (!s.playing) await playNext(gid);
  return { content: `追加: **${track.info?.title || '(unknown)'}**` };
}

export async function skipCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  const hasSomething = !!s.current || s.queue.length > 0 || s.playing;
  if (!hasSomething) {
    return { ephemeral: true, content: '何も再生してないみたい。' };
  }
  if (s.loop === LOOP.track) s.loop = LOOP.off;
  s.playing = false;
  // Lavalink v4/ Shoukaku v4 は stop() が本命。互換のため両方叩く。
  try {
    if (typeof s.conn?.stop === 'function') {
      await s.conn.stop();
    } else if (typeof s.conn?.stopTrack === 'function') {
      await s.conn.stopTrack();
    }
  } catch {}
  return { content: '⏭ スキップしたよ（単曲ループは解除）。' };
}

export async function leaveCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  // /leave ウィンドウ中はプレイヤー終端/空VC/idleの全通知を黙らせる
  s.selfLeaveUntil = Date.now() + 10000;
  cancelIdle(gid);
  await leaveHardAndClear(gid);
  return { content: '👋 退出してキューをクリアしたよ。' };
}

export function queueCommand({ itx }) {
  const { maxQueue } = useGlue();
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  const lines = [];
  if (s.current) lines.push(`**▶ 再生中:** ${s.current.info?.title || '(unknown)'} — ${s.current.info?.author || ''}`);
  s.queue.slice(0, 10).forEach((t, idx) => lines.push(`${idx + 1}. ${t.info?.title || '(unknown)'} — ${t.info?.author || ''}`));
  if (lines.length === 0) return { ephemeral: true, content: 'キューは空だよ！' };

  return {
    embeds: [{
      title: 'Totoro Queue',
      description: lines.join('\n'),
      fields: [
        { name: 'Loop', value: String(s.loop), inline: true },
        { name: 'Queue Size', value: `${s.queue.length}/${maxQueue}`, inline: true }
      ]
    }]
  };
}

// === Loop commands ===
export function loopCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  s.loop = s.loop === LOOP.track ? LOOP.off : LOOP.track;
  return { content: `🔁 単曲ループ: **${s.loop === LOOP.track ? 'ON' : 'OFF'}**` };
}

export function loopQueueCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  s.loop = s.loop === LOOP.queue ? LOOP.off : LOOP.queue;
  return { content: `🔂 キューループ: **${s.loop === LOOP.queue ? 'ON' : 'OFF'}**` };
}
