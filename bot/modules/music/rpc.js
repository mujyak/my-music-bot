// modules/music/rpc.js
// 役割: interaction無しで音楽操作を実行する入口（ワーカーRPC用）

import { useGlue } from './glue.js';
import { getState } from './state.js';
import { ensureConnectionV4 } from './lavalink.js';
import {
  resolveYouTube,
  playNext,
  skipCommand,
  queueCommand,
  leaveCommand,
  loopCommand,
  loopQueueCommand,
  shuffleCommand
} from './service.js';

// service.js と同じ見た目のEmbed（色も合わせる）
function buildMusicEmbed(description, title) {
  const embed = { description, color: 0x7cc5ff };
  if (title) embed.title = title;
  return embed;
}

async function getMeVoiceChannelId(gid) {
  const { client } = useGlue();
  if (!client) return null;

  const guild =
    client.guilds.cache.get(gid) ??
    (await client.guilds.fetch(gid).catch(() => null));
  if (!guild) return null;

  const me =
    guild.members?.me ??
    (await guild.members.fetchMe().catch(() => null));
  return me?.voice?.channelId ?? null;
}

// 指定VCへ送信（送れなければ黙る）
async function sendToVc(gid, vcId, payload) {
  const { sendToChannel } = useGlue();
  if (!sendToChannel || !vcId) return false;
  try {
    return await sendToChannel(gid, vcId, payload);
  } catch {
    return false;
  }
}

// =============== RPC: status ===============
export async function getRpcStatus() {
  const { client } = useGlue();
  const profile = String(process.env.BOT_PROFILE ?? 'unknown').toLowerCase();

  if (!client) return { profile, sessions: [] };

  const sessions = [];
  for (const [gid, guild] of client.guilds.cache) {
    const me = guild.members?.me ?? (await guild.members.fetchMe().catch(() => null));
    const vcId = me?.voice?.channelId ?? null;
    if (!vcId) continue;

    const st = getState(gid);
    sessions.push({
      guildId: String(gid),
      voiceChannelId: String(vcId),
      textChannelId: st?.lastTextChannelId ? String(st.lastTextChannelId) : null,
    });
  }
  return { profile, sessions };
}

// =============== RPC: play ===============
export async function rpcPlay(payload = {}) {
  const { maxQueue } = useGlue();

  const guildId = String(payload.guildId ?? '');
  const vcId = String(payload.voiceChannelId ?? '');
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;
  const query = String(payload.query ?? '').trim();

  if (!guildId || !vcId || !query) {
    return { error: 'missing guildId/voiceChannelId/query' };
  }

  const s = getState(guildId);
  s.lastTextChannelId = textChannelId ?? s.lastTextChannelId ?? null;
  s.lastVcId = vcId;

  // 横取り防止：既に別VCに居るなら拒否
  const currentVc = await getMeVoiceChannelId(guildId);
  if (currentVc && String(currentVc) !== vcId) {
    await sendToVc(guildId, vcId, {
      embeds: [buildMusicEmbed('今は他のVCで使用中かも…(/ᐛ\\)')],
    });
    return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };
  }

  // 先に解決（成功してから接続）
  const resolved = await resolveYouTube(query);
  const tracksRaw = Array.isArray(resolved?.tracks) ? resolved.tracks : [];
  const tracks = tracksRaw.filter(t => t?.encoded);
  const isPlaylist = !!resolved?.playlist;
  const first = tracks[0];

  if (!first?.encoded) {
    await sendToVc(guildId, vcId, {
      embeds: [buildMusicEmbed('見つからなかった…(´._.`)')],
    });
    return { error: 'not_found' };
  }

  const room = Math.max(0, (maxQueue ?? 100) - s.queue.length);
  if (!isPlaylist && room <= 0) {
    await sendToVc(guildId, vcId, {
      embeds: [buildMusicEmbed(`これ以上は入らないよ( ᐛ )（上限${maxQueue ?? 100}）`)],
    });
    return { error: 'queue_full' };
  }

  // ここで初めて接続（同じVCならスキップ）
  const alreadyIn = !!currentVc && String(currentVc) === vcId;
  if (!alreadyIn) {
    try {
      await ensureConnectionV4(guildId, vcId);
    } catch (e) {
      await sendToVc(guildId, vcId, {
        embeds: [buildMusicEmbed('接続に失敗しちゃった…もう一度試してみてね。( ; ; )')],
      });
      return { error: 'connect_failed', message: e?.message };
    }
  }

  // キュー投入 & 必要なら再生開始（service.js と同じ挙動）
  if (!isPlaylist) {
    s.queue.push(first);
    if (!s.playing) await playNext(guildId);

    await sendToVc(guildId, vcId, {
      embeds: [buildMusicEmbed(`**${first.info?.title || '(unknown)'}**`, 'プレイリストに追加(・∀・)')],
    });
    return { ok: true, playlist: false, added: 1 };
  }

  // playlist
  let added = 0;
  if (!s.playing) {
    s.queue.push(first);
    added++;

    const rest = tracks.slice(1);
    const roomAfterFirst = Math.max(0, (maxQueue ?? 100) - s.queue.length);
    const toAdd = rest.slice(0, roomAfterFirst);
    s.queue.push(...toAdd);
    added += toAdd.length;

    await playNext(guildId);
  } else {
    const toAdd = tracks.slice(0, room);
    if (toAdd.length > 0) {
      s.queue.push(...toAdd);
      added += toAdd.length;
    }
  }

  const more = tracks.length - added;
  if (added === 0) {
    await sendToVc(guildId, vcId, {
      embeds: [buildMusicEmbed(`プレイリスト追加できなかった…( ᐛ )（キュー上限${maxQueue ?? 100}）`)],
    });
    return { error: 'queue_full_playlist' };
  }

  const tail = more > 0 ? `（${added}件追加・${more}件は上限で見送り）` : `（${added}件追加）`;
  await sendToVc(guildId, vcId, {
    embeds: [buildMusicEmbed(`プレイリストを追加(・∀・) ${tail}`)],
  });
  return { ok: true, playlist: true, added };
}

// =============== RPC: skip/queue/leave ===============
export async function rpcSkip(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;

  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);
  if (!targetVc) return { error: 'not_in_voice' };

  // 安全：別VCを指定されたら拒否
  if (currentVc && String(currentVc) !== targetVc) {
    return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };
  }

  const resp = await skipCommand({ itx: { guildId, channelId: textChannelId ?? targetVc } });
  await sendToVc(guildId, targetVc, resp?.embeds ? { embeds: resp.embeds } : (resp?.content ?? ''));
  return { ok: true };
}

export async function rpcQueue(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;

  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);
  if (!targetVc) return { error: 'not_in_voice' };

  if (currentVc && String(currentVc) !== targetVc) {
    return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };
  }

  const resp = await queueCommand({ itx: { guildId, channelId: textChannelId ?? targetVc } });
  if (resp?.embeds) await sendToVc(guildId, targetVc, { embeds: resp.embeds });
  else if (resp?.content) await sendToVc(guildId, targetVc, resp.content);
  return { ok: true };
}

export async function rpcLeave(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;

  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);

  const resp = await leaveCommand({ itx: { guildId, channelId: textChannelId ?? targetVc ?? '0' } });

  // 退出後でも送れることが多いので、最後に送信（失敗してもOK）
  if (targetVc && resp?.embeds) await sendToVc(guildId, targetVc, { embeds: resp.embeds });

  return { ok: true };
}

export async function rpcLoop(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;
  const query = String(payload.query ?? '').trim();

  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);
  if (!targetVc) return { error: 'not_in_voice' };
  if (currentVc && String(currentVc) !== targetVc) {
    return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };
  }

  const resp = await loopCommand({
    itx: {
      guildId,
      channelId: textChannelId ?? targetVc,
      voiceChannelId: targetVc,
    },
    q: query || undefined,
    notify: false,
  });

  if (resp?.embeds) await sendToVc(guildId, targetVc, { embeds: resp.embeds });
  else if (resp?.content) await sendToVc(guildId, targetVc, resp.content);

  return { ok: true };
}

export async function rpcLoopQueue(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;
  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);
  if (!targetVc) return { error: 'not_in_voice' };
  if (currentVc && String(currentVc) !== targetVc) return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };

  const resp = await loopQueueCommand({ itx: { guildId, channelId: textChannelId ?? targetVc } });
  if (resp?.embeds) await sendToVc(guildId, targetVc, { embeds: resp.embeds });
  else if (resp?.content) await sendToVc(guildId, targetVc, resp.content);
  return { ok: true };
}

export async function rpcShuffle(payload = {}) {
  const guildId = String(payload.guildId ?? '');
  const vcId = payload.voiceChannelId ? String(payload.voiceChannelId) : null;
  const textChannelId = payload.textChannelId ? String(payload.textChannelId) : null;
  if (!guildId) return { error: 'missing guildId' };

  const currentVc = await getMeVoiceChannelId(guildId);
  const targetVc = vcId ?? (currentVc ? String(currentVc) : null);
  if (!targetVc) return { error: 'not_in_voice' };
  if (currentVc && String(currentVc) !== targetVc) return { error: 'busy_in_other_vc', currentVcId: String(currentVc) };

  const resp = await shuffleCommand({ itx: { guildId, channelId: textChannelId ?? targetVc } });
  if (resp?.embeds) await sendToVc(guildId, targetVc, { embeds: resp.embeds });
  else if (resp?.content) await sendToVc(guildId, targetVc, resp.content);
  return { ok: true };
}