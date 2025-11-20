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

  // v4 形状をちゃんとほどく
  let arr = [];
  if (loadType === 'playlist') {
    // playlist は res.data.tracks が配列
    arr = toArray(res?.data?.tracks);
  } else if (Array.isArray(res?.data)) {
    arr = res.data;
  } else if (Array.isArray(res?.tracks)) {
    arr = res.tracks;
  } else if (res?.data && typeof res.data === 'object' && res.data.encoded) {
    // 単発 track がオブジェクトで返るケースの保険
    arr = [res.data];
  }

  if (debugResolve) console.log(`[resolve] ${loadType} x${arr.length}`);

  if (!res || !loadType || arr.length === 0) {
    return { tracks: [], playlist: false, loadType: 'empty' };
  }
  if (loadType === 'error') {
    return { tracks: [], playlist: false, loadType: 'error', message: res?.data?.message };
  }

  switch (loadType) {
    case 'track':    return { tracks: arr.slice(0, 1), playlist: false, loadType };
    case 'search':   return { tracks: arr.slice(0, 1), playlist: false, loadType };
    case 'playlist': return { tracks: arr,            playlist: true,  loadType }; // 全曲返す
    default:         return { tracks: arr.slice(0, 1), playlist: false, loadType };
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
  await sendToCurrentVc(gid, `▶ 再生開始(・∀・): **${title}**`).catch(() => {});

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
    await sendToCurrentVc(gid, '静かになったから落ちるね( ＾ω＾ )」 ﾏﾀﾅ').catch(() => {});
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
  if (!vcId) return { ephemeral: true, content: '先にボイスチャンネルに参加してちょ(´Д` )' };
  st.lastVcId = vcId;

  // 2) 横取り禁止（同ギルド内の別VCに居るなら拒否：まだdeferしない）
  try {
    const me = itx.guild?.members?.me ?? await itx.guild?.members.fetchMe().catch(() => null);
    const currentVcId = me?.voice?.channelId ?? null;
    if (currentVcId && currentVcId !== vcId) {
      return {
        ephemeral: true,
        content: '今は他のVCで使用中かも…(/ᐛ\\\\)'
      };
    }
  } catch { /* 無視して従来処理へ */ }

  // 3) 遅延応答開始（以降は editReply で返す）
  await itx.deferReply();

  // 4) 解決（成功してから接続する）
  const resolved = await resolveYouTube(q.trim());
  const tracksRaw = Array.isArray(resolved?.tracks) ? resolved.tracks : [];
  const tracks = tracksRaw.filter(t => t?.encoded); // 壊れトラック除去
  const isPlaylist = !!resolved?.playlist;
  const first = tracks[0];
  if (!first?.encoded) {
    // 未接続のまま終了
    return { content: '見つからなかった…(´._.`)' };
  }

  // 5) 上限チェック（まだ未接続なので入室せずに終了可能）
  const s = getState(gid);
  const room = Math.max(0, maxQueue - s.queue.length);
  if (!isPlaylist && room <= 0) {
    return { content: `これ以上は入らないよ( ᐛ )（上限${maxQueue}）` };
  }

  // 6) ここで初めて接続（同じVCならスキップ）
  const alreadyIn = await isInSameVc(gid, vcId);
  if (!alreadyIn) {
    try {
      await ensureConnectionV4(gid, vcId);
    } catch (e) {
      console.error('[ensureConnectionV4]', e?.message || e);
      return { content: '接続に失敗しちゃった…もう一度試してみてね。( ; ; )' };
    }
  }

  // 7) キュー投入 & 必要なら再生開始
  if (!isPlaylist) {
    // 単発
    s.queue.push(first);
    if (!s.playing) await playNext(gid);
    return { content: `プレイリストに追加(・∀・): **${first.info?.title || '(unknown)'}**` };
  } else {
    // プレイリスト：要件
    // - 未再生なら「先頭1曲を即再生」＆「残りをキュー投入」
    // - 既に再生中なら「全曲をキュー投入」
    // - 上限を超える分は切り捨て
    let added = 0;
    if (!s.playing) {
      // 先頭1曲ぶんは playNext に任せるためキューへ入れる
      s.queue.push(first);
      added++;
      // 残りを上限の範囲で投入
      const rest = tracks.slice(1);
      const roomAfterFirst = Math.max(0, maxQueue - s.queue.length);
      const toAdd = rest.slice(0, roomAfterFirst);
      s.queue.push(...toAdd);
      added += toAdd.length;
      await playNext(gid);
    } else {
      const toAdd = tracks.slice(0, room);
      if (toAdd.length > 0) {
        s.queue.push(...toAdd);
        added += toAdd.length;
      }
    }
    const more = tracks.length - added;
    if (added === 0) {
      return { content: `プレイリスト追加できなかった…( ᐛ )（キュー上限${maxQueue}）` };
    }
    const tail = more > 0 ? `（${added}件追加・${more}件は上限で見送り）` : `（${added}件追加）`;
    return { content: `プレイリストを追加(・∀・) ${tail}` };
  }
}

export async function skipCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  const hasSomething = !!s.current || s.queue.length > 0 || s.playing;
  if (!hasSomething) {
    return { ephemeral: true, content: '何も再生してないかも(||´Д｀)' };
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
  return { content: '⏭ スキップしたよん=͟͟͞͞ ( ˙꒳​˙)' };
}

export async function leaveCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  // /leave ウィンドウ中はプレイヤー終端/空VC/idleの全通知を黙らせる
  s.selfLeaveUntil = Date.now() + 10000;
  cancelIdle(gid);
  await leaveHardAndClear(gid);
  return { content: 'またいつでも呼んでね( ＾ω＾ )」 ﾏﾀﾅ' };
}

export function queueCommand({ itx }) {
  const { maxQueue } = useGlue();
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  const lines = [];
  if (s.current) lines.push(`**▶ 再生中:** ${s.current.info?.title || '(unknown)'} — ${s.current.info?.author || ''}`);
  s.queue.slice(0, 10).forEach((t, idx) => lines.push(`${idx + 1}. ${t.info?.title || '(unknown)'} — ${t.info?.author || ''}`));
  if (lines.length === 0) return { ephemeral: true, content: 'プレイリストに何も入ってないかも(´-ω-)' };

  return {
    embeds: [{
      title: '現在のプレイリスト',
      description: lines.join('\n'),
      fields: [
        { name: 'ループ', value: loopLabel(s.loop), inline: true },
        { name: 'プレイリスト件数', value: `${s.queue.length}/${maxQueue}`, inline: true }
      ]
    }]
  };
}

function loopLabel(loop) {
  switch (loop) {
    case 'track': return '単曲';
    case 'queue': return '全体';
    default:      return 'なし';
  }
}

// === Loop commands ===
export function loopCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  s.loop = s.loop === LOOP.track ? LOOP.off : LOOP.track;
  return { content: `単曲ループ開始(・∀・): **${s.loop === LOOP.track ? 'ON' : 'OFF'}**` };
}

export function loopQueueCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);
  s.loop = s.loop === LOOP.queue ? LOOP.off : LOOP.queue;
  return { content: `全体ループ開始(・∀・): **${s.loop === LOOP.queue ? 'ON' : 'OFF'}**` };
}

export function shuffleCommand({ itx }) {
  const gid = itx.guildId;
  getState(gid).lastTextChannelId = itx.channelId;
  const s = getState(gid);

  if (!s.queue?.length) {
    return { ephemeral: true, content: 'シャッフルする曲がないかも…|ω･`)' };
  }

  // Fisher–Yates shuffle（キューだけ・再生中はそのまま）
  for (let i = s.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
  }
  return { content: `プレイリストをシャッフルしたよ( ◜ω◝و)و（${s.queue.length}件）` };
}