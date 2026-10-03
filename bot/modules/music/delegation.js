// modules/music/delegation.js
import { createRpcClient } from '../worker_rpc/client.js';

const PROFILE = String(process.env.BOT_PROFILE ?? 'totoro').toLowerCase();

function splitList(v) {
  return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
const DELEGATION_SET = new Set(splitList(process.env.DELEGATION_GUILDS));

const nakatoro = createRpcClient({
  baseUrl: process.env.NAKATORO_RPC_URL ?? '',
  token: process.env.NAKATORO_RPC_TOKEN ?? '',
});
const kototoro = createRpcClient({
  baseUrl: process.env.KOTOTORO_RPC_URL ?? '',
  token: process.env.KOTOTORO_RPC_TOKEN ?? '',
});

let _cache = { t: 0, naka: null, koto: null };

async function fetchStatusesCached() {
  const now = Date.now();
  if (now - _cache.t < 800 && _cache.naka && _cache.koto) return _cache;

  const [naka, koto] = await Promise.all([
    nakatoro.status().catch(() => ({ ok: false, status: { sessions: [] } })),
    kototoro.status().catch(() => ({ ok: false, status: { sessions: [] } })),
  ]);
  _cache = { t: now, naka, koto };
  return _cache;
}

function isDelegationEnabled(gid) {
  // 空なら「代打なし」運用に寄せる（事故防止）
  if (DELEGATION_SET.size === 0) return false;
  return DELEGATION_SET.has(String(gid));
}

function getUserVcId(itx) {
  return (
    itx.member?.voice?.channelId ||
    itx.guild?.voiceStates?.cache?.get(itx.user.id)?.channelId ||
    null
  );
}

function getTotoroGuildVcId(itx) {
  return itx.guild?.members?.me?.voice?.channelId ?? null;
}

function findSessionForVc(statusObj, gid, vcId) {
  const sessions = statusObj?.status?.sessions ?? [];
  return (
    sessions.find(
      s =>
        String(s.guildId) === String(gid) &&
        String(s.voiceChannelId) === String(vcId)
    ) ?? null
  );
}

function hasSessionInGuild(statusObj, gid) {
  const sessions = statusObj?.status?.sessions ?? [];
  return sessions.some(s => String(s.guildId) === String(gid));
}

function buildUsedMap(itx, naka, koto) {
  const gid = String(itx.guildId);
  return {
    totoro: !!getTotoroGuildVcId(itx),
    nakatoro: hasSessionInGuild(naka, gid),
    kototoro: hasSessionInGuild(koto, gid),
  };
}

async function forwardToWorker(itx, who, cmd, payload) {
  const client = who === 'nakatoro' ? nakatoro : kototoro;

  if (cmd === 'play') await client.play(payload);
  else if (cmd === 'skip') await client.skip(payload);
  else if (cmd === 'leave') await client.leave(payload);
  else if (cmd === 'queue') await client.queue(payload);
  else if (cmd === 'loop') await client.loop(payload);
  else if (cmd === 'loop_queue') await client.loopQueue(payload);
  else if (cmd === 'shuffle') await client.shuffle(payload);
  else throw new Error('unknown cmd');

  const name = who === 'nakatoro' ? '中トトロ' : '小トトロ';
  const msg = `${name}が対応するよ(　◜ω◝　)`;

  if (itx.deferred || itx.replied) await itx.editReply(msg);
  else await itx.reply(msg);

  return true;
}

export async function maybeForwardMusic(itx, cmdName, extra = {}) {
  // Totoroだけがルーティングする
  if (PROFILE !== 'totoro') return false;

  const gid = itx.guildId;
  if (!gid) return false;
  if (!isDelegationEnabled(gid)) return false;

  const userVcId = getUserVcId(itx);
  const hasQuery = typeof extra?.q === 'string' && extra.q.trim().length > 0;
  const isLoopWithQuery = cmdName === 'totoro_loop' && hasQuery;

  // play以外はVC必須。
  // loop(inputあり)も、追加後に単曲ループ再生するためVC必須。
  const needsVc = cmdName !== 'totoro_play';
  if (needsVc && !userVcId) {
    if (!itx.deferred && !itx.replied) {
      await itx.reply({ content: '先にボイスチャンネルに入ってね(　◜ω◝　)', ephemeral: true });
    }
    return true;
  }

  const { naka, koto } = await fetchStatusesCached();

  // ① そのVCの担当が既に居るなら、そっちへ必ず転送（奪わない）
  if (userVcId) {
    const totoroVc = getTotoroGuildVcId(itx);
    if (totoroVc && String(totoroVc) === String(userVcId)) {
      return false; // Totoro担当なのでローカル実行
    }

    if (findSessionForVc(naka, gid, userVcId)) {
      return forwardToWorker(itx, 'nakatoro', mapCmd(cmdName), buildPayload(itx, userVcId, extra));
    }
    if (findSessionForVc(koto, gid, userVcId)) {
      return forwardToWorker(itx, 'kototoro', mapCmd(cmdName), buildPayload(itx, userVcId, extra));
    }
  }

  // ② play または loop(inputあり) で「未担当」のときだけ、
  //    そのギルド内で未使用のBotを優先順で割り当て
  if (cmdName === 'totoro_play' || isLoopWithQuery) {
    // VC未参加は既存playCommandに任せる
    if (!userVcId) return false;

    const used = buildUsedMap(itx, naka, koto);

    for (const who of ['totoro', 'nakatoro', 'kototoro']) {
      if (used[who]) continue;

      if (who === 'totoro') {
        return false; // Totoro未使用ならTotoroが担当
      }

      return forwardToWorker(itx, who, mapCmd(cmdName), buildPayload(itx, userVcId, extra));
    }

    // このギルド内で全員使用中
    if (!itx.deferred && !itx.replied) {
      await itx.reply({
        content: 'このサーバーでは既に3つのVCで使用中かも…(/ᐛ\\) 少し待ってね',
        ephemeral: true,
      });
    }
    return true;
  }

  // ③ それ以外（未担当のskip等）は「このVCでは再生してない」扱いにして奪取事故を防ぐ
  if (!itx.deferred && !itx.replied) {
    await itx.reply({ content: 'このVCでは再生してないかも…|ω･`)', ephemeral: true });
  }
  return true;
}

function mapCmd(cmdName) {
  switch (cmdName) {
    case 'totoro_play': return 'play';
    case 'totoro_skip': return 'skip';
    case 'totoro_leave': return 'leave';
    case 'totoro_queue': return 'queue';
    case 'totoro_loop': return 'loop';
    case 'totoro_loop_queue': return 'loop_queue';
    case 'totoro_shuffle': return 'shuffle';
    default: return null;
  }
}

function buildPayload(itx, vcId, extra) {
  const base = {
    guildId: String(itx.guildId),
    voiceChannelId: String(vcId),
    textChannelId: String(itx.channelId),
    requestedBy: {
      id: String(itx.user?.id ?? '0'),
      name: String(itx.user?.username ?? 'unknown'),
    },
  };

  if (extra?.q) base.query = String(extra.q);
  return base;
}