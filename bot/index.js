// index.js — Totoro-bot core
// 目的:
// - 3体構成（Totoro / 中トトロ / 小トトロ）を「同一コード」で起動できるようにする
// - Totoro はフル機能（音楽 + XP/誕生日/アワード/各種ミニゲーム等）
// - 中/小は基本「ワーカー運用」＝スラッシュ無し＆音楽だけ（将来スラッシュONも可能）
//
// 起動方法（docker-compose.yml で BOT_PROFILE を渡す想定）:
// - BOT_PROFILE=totoro     -> Totoro（フル機能）
// - BOT_PROFILE=nakatoro   -> 中トトロ（音楽ワーカー）
// - BOT_PROFILE=kototoro   -> 小トトロ（音楽ワーカー）

// ===== Imports =====
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';

// XP
import { initXpSystem, buildXpCommands } from './modules/xp/xp.js';

// Birthday notifier (JST 0:00)
import { scheduleBirthdayNotifier } from './modules/birthday/notifier.js';

// Awards (寝落ち / フリバ)
import {
  buildAwardCommands,
  wireAwardHandlers,
  dispatchAwardInteraction,
  setFreebattleConfig
} from './modules/awards/index.js';

// Chatter
import { wireChatterHandlers } from './modules/chatter/index.js';

// Teams
import { buildTeamsCommands, wireTeamHandlers } from './modules/teams/index.js';

// Dice
import { buildDiceCommands, wireDiceHandlers } from './modules/dice/index.js';

// Gacha
import {
  buildGachaCommands,
  handleGachaSlash,
  dispatchGachaInteraction
} from './modules/gacha/index.js';

// Roles (称号など)
import { wireRoleHandlers } from './modules/roles/index.js';

// Omikuji
import { buildOmikujiCommands, dispatchOmikujiInteraction } from './modules/omikuji/index.js';

// Hayaoshi
import { buildHayaoshiCommands, handleHayaoshiSlash } from './modules/hayaoshi/index.js';

// Intro Quiz
import { buildIntroCommands, dispatchIntroInteraction } from './modules/introquiz/index.js';

// Kojin
import { buildKojinCommands, dispatchKojinInteraction } from './modules/kojin/index.js';

// Music (Shoukaku/Lavalink)
import {
  installMusicModule,
  buildMusicCommands,
  wireMusicHandlers,
  dispatchMusicInteraction,
  rpcPlay,
  rpcSkip,
  rpcLeave,
  rpcQueue,
  rpcLoop,
  rpcLoopQueue,
  rpcShuffle,
  getRpcStatus
} from './modules/music/index.js';

import { startWorkerRpcServer } from './modules/worker_rpc/server.js';

import { wireSuggestionHandlers } from './modules/suggestions/index.js';

import { initNoticeBoard } from './modules/notice-board/index.js';

// Role Sync
import { setupRoleSync } from './modules/role-sync/index.js';

// =========================================================
// Env / Profile selection
// =========================================================
const {
  BOT_PROFILE = 'totoro', // totoro / nakatoro / kototoro

  // per-bot tokens/ids
  TOTORO_DISCORD_TOKEN,
  TOTORO_CLIENT_ID,
  TOTORO_GUILD_ID,
  TOTORO_ALLOW_GUILDS,

  NAKATORO_DISCORD_TOKEN,
  NAKATORO_CLIENT_ID,
  NAKATORO_GUILD_ID,
  NAKATORO_ALLOW_GUILDS,

  KOTORO_DISCORD_TOKEN,
  KOTORO_CLIENT_ID,
  KOTORO_GUILD_ID,
  KOTORO_ALLOW_GUILDS,

  // optional: enable slash for workers (future)
  NAKATORO_ENABLE_SLASH,
  KOTORO_ENABLE_SLASH,

  // shared
  LAVALINK_PASSWORD,
  NOTICE_CHANNEL_ID,
  TOTORO_DEBUG_RESOLVE // '1' で音楽解決ログON
} = process.env;

const PROFILE = String(BOT_PROFILE || 'totoro').toLowerCase();
const IS_TOTORO = PROFILE === 'totoro';

function pickByProfile({ totoro, nakatoro, kototoro }) {
  if (PROFILE === 'nakatoro') return nakatoro;
  if (PROFILE === 'kototoro') return kototoro;
  return totoro;
}

const DISCORD_TOKEN = pickByProfile({
  totoro: TOTORO_DISCORD_TOKEN,
  nakatoro: NAKATORO_DISCORD_TOKEN,
  kototoro: KOTORO_DISCORD_TOKEN
});

const CLIENT_ID = pickByProfile({
  totoro: TOTORO_CLIENT_ID,
  nakatoro: NAKATORO_CLIENT_ID,
  kototoro: KOTORO_CLIENT_ID
});

const GUILD_ID = pickByProfile({
  totoro: TOTORO_GUILD_ID,
  nakatoro: NAKATORO_GUILD_ID,
  kototoro: KOTORO_GUILD_ID
});

const ALLOW_GUILDS = pickByProfile({
  totoro: TOTORO_ALLOW_GUILDS,
  nakatoro: NAKATORO_ALLOW_GUILDS,
  kototoro: KOTORO_ALLOW_GUILDS
});

// 将来、中/小にもスラッシュ登録したい時のONスイッチ
// いまは totoro だけが true（ワーカーは false）で運用する想定
const ENABLE_SLASH =
  IS_TOTORO ||
  (PROFILE === 'nakatoro' && NAKATORO_ENABLE_SLASH === '1') ||
  (PROFILE === 'kototoro' && KOTORO_ENABLE_SLASH === '1');

// =========================================================
// Helpers / Derived settings
// =========================================================
function splitList(v) {
  return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

const ALLOW_SET = new Set(splitList(ALLOW_GUILDS)); // 利用許可ギルド（空=全許可）
const REG_TARGET_SET = new Set([...splitList(GUILD_ID), ...ALLOW_SET]); // スラッシュ登録対象（参加チェックで間引く）
const DEBUG_RESOLVE = TOTORO_DEBUG_RESOLVE === '1';

function isAllowedGuild(gid) {
  return ALLOW_SET.size === 0 || ALLOW_SET.has(String(gid));
}

// =========================================================
// Constants
// =========================================================
const MAX_QUEUE = 100;

// =========================================================
// Lavalink Nodes
// =========================================================
const NODES = [
  { name: 'main', url: 'lavalink:2333', auth: LAVALINK_PASSWORD, secure: false }
];

// =========================================================
// Slash Commands
// - Totoro: music + all core
// - Workers: (ENABLE_SLASH=1 の時だけ) music only
// =========================================================
const coreCommands = IS_TOTORO ? [
  ...buildXpCommands(),
  ...buildAwardCommands(),
  ...buildTeamsCommands(),
  ...buildDiceCommands(),
  ...buildGachaCommands(),
  ...buildOmikujiCommands(),
  ...buildHayaoshiCommands(),
  ...buildIntroCommands(),
  ...buildKojinCommands(),
] : [];

// =========================================================
// Discord Client & Shoukaku
// =========================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, // teams/hayaoshi など
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember,
  ],
});

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), NODES, {
  moveOnDisconnect: false,
  resumable: true,
  resumableTimeout: 60
});

// =========================================================
// Allowlist: ギルド参加時に許可外なら即退出
// =========================================================
client.on('guildCreate', guild => {
  if (!isAllowedGuild(guild.id)) {
    console.log(`[ALLOWLIST] not allowed guild ${guild.id} (${guild.name}) -> leaving`);
    guild.leave().catch(() => {});
  }
});

// =========================================================
// Notice Helpers（安全: テキストチャンネル限定）
// =========================================================

// 通知先チャンネル選定（固定ID > システム > 最初の送信可能テキスト）
async function findNoticeChannel(guild) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe();

    // 1) 固定チャンネルIDがあれば最優先
    if (NOTICE_CHANNEL_ID) {
      const fixed = guild.channels.cache.get(NOTICE_CHANNEL_ID)
        ?? await guild.channels.fetch(NOTICE_CHANNEL_ID).catch(() => null);

      if (
        fixed &&
        typeof fixed.isTextBased === 'function' && fixed.isTextBased() &&
        !(typeof fixed.isThread === 'function' && fixed.isThread()) &&
        fixed.viewable &&
        fixed.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
      ) {
        return fixed;
      }
    }

    // 2) システムチャンネル
    const sys = guild.systemChannel;
    if (
      sys &&
      sys.viewable &&
      sys.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
    ) {
      return sys;
    }

    // 3) 送信可能な通常テキストから探す
    const ch = guild.channels.cache.find(c =>
      typeof c?.isTextBased === 'function' && c.isTextBased() &&
      !(typeof c.isThread === 'function' && c.isThread()) &&
      c.viewable &&
      c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
      c.type !== ChannelType.GuildAnnouncement
    );

    return ch ?? null;
  } catch {
    return null;
  }
}

async function sendNotice(gid, content) {
  try {
    const guild = client.guilds.cache.get(gid);
    if (!guild) return;
    const ch = await findNoticeChannel(guild);
    if (ch) await ch.send(content);
  } catch (e) {
    console.warn('[notice]', e?.message || e);
  }
}

// 任意のチャンネルIDへ直接送る（テキスト限定 & 権限チェック）
async function sendToChannel(gid, channelId, content) {
  try {
    const guild = client.guilds.cache.get(gid);
    if (!guild) return false;

    const ch = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return false;

    const me = guild.members.me ?? await guild.members.fetchMe();

    const isTextLike = (typeof ch.isTextBased === 'function' && ch.isTextBased());
    const notThread = typeof ch.isThread === 'function' ? !ch.isThread() : true;
    const perms = ch.permissionsFor(me);

    const canSend =
      isTextLike && notThread &&
      ch.viewable &&
      perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms?.has(PermissionFlagsBits.SendMessages);

    if (canSend) {
      await ch.send(content);
      return true;
    }
  } catch (e) {
    console.warn('[sendToChannel]', e?.message || e);
  }
  return false;
}

// =========================================================
// XP system (Totoro only)
// =========================================================
const xp = IS_TOTORO
  ? initXpSystem(client, (gid, content) => sendNotice(gid, content))
  : null;

// =========================================================
// Interactions
// - Totoro: 全部処理
// - Workers: ENABLE_SLASH=1 の場合のみ / 音楽だけ処理（安全運用）
// =========================================================
client.on('interactionCreate', async i => {
  try {
    // ---- 利用許可ギルドチェック（共通） ----
    if (i.guildId && !isAllowedGuild(i.guildId)) {
      if (i.isChatInputCommand()) {
        return i.reply({
          content: 'このサーバでは利用許可がありません。',
          ephemeral: true
        });
      }
      return; // ボタン等は黙って無視
    }

    // ---- ワーカー運用: 基本 interaction は無視（将来 ENABLE_SLASH=1 の時だけ動く） ----
    if (!ENABLE_SLASH) return;

    // ---- ① ボタン / セレクト（totoroのみ） ----
    if (i.isButton() || i.isStringSelectMenu()) {
      if (!IS_TOTORO) return;

      const handledGacha = await dispatchGachaInteraction(i);
      if (handledGacha) return;

      return;
    }

    // ---- ② スラッシュコマンドのみ ----
    if (!i.isChatInputCommand()) return;

    // ---- ワーカーでスラッシュONにした場合：まずは音楽だけ処理（安全） ----
    if (!IS_TOTORO) {
      const handledMusic = await dispatchMusicInteraction(i);
      if (handledMusic) return;
      return;
    }

    // ===== ここから totoro のみ =====

    // 早押し
    if (i.commandName === 'totoro_hayaoshi') {
      await handleHayaoshiSlash(i);
      return;
    }

    // Kojin
    if (await dispatchKojinInteraction(i)) return;

    // XP
    if (xp && [
      'totoro_exp',
      'totoro_exp_rank',
      'totoro_exp_year',
      'totoro_exp_year_rank',
      'totoro_exp_management',
      'totoro_exp_year_management'
    ].includes(i.commandName)) {
      const handled = await xp.handleSlash?.(i);
      if (handled !== false) return;
    }

    // Omikuji
    if (await dispatchOmikujiInteraction(i)) return;

    // Intro Quiz
    if (await dispatchIntroInteraction(i)) return;

    // Music
    if (await dispatchMusicInteraction(i)) return;

    // Awards
    if (await dispatchAwardInteraction(i)) return;

    // Gacha slash
    if (await handleGachaSlash(i)) return;

    // その他は各モジュール側が拾う
  } catch (e) {
    console.error('[interaction] failed:', e);
    try {
      if (i.deferred) {
        await i.editReply('エラーが起きたみたい…ログを見てみてね。');
      } else {
        await i.reply({
          content: 'エラーが起きたみたい…',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch {}
  }
});

// =========================================================
// Slash command registration
// =========================================================
async function registerCommands() {
  if (!ENABLE_SLASH) return;

  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required');
  if (!CLIENT_ID) throw new Error('CLIENT_ID is required');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  const commands = IS_TOTORO
    ? [...buildMusicCommands(), ...coreCommands]
    : [...buildMusicCommands()];

  if (REG_TARGET_SET.size > 0) {
    for (const gid of REG_TARGET_SET) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commands });
        console.log(`[slash] Registered GUILD commands to ${gid}`);
      } catch (e) {
        console.error(`[slash] Failed to register to ${gid}`, e?.message || e);
      }
    }
  } else {
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('[slash] Registered GLOBAL commands (反映に時間がかかる場合があります)');
    } catch (e) {
      console.error('[slash] Failed to register GLOBAL commands', e?.message || e);
    }
  }
}

// =========================================================
// Ready (one-shot)
// =========================================================
function onReadyOnce() {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`[profile] BOT_PROFILE=${PROFILE}`);
  console.log(`[allow] ALLOW_GUILDS: ${ALLOW_SET.size ? [...ALLOW_SET].join(',') : '(not set = all allowed)'}`);
  console.log(`[slash] enabled=${ENABLE_SLASH} target=${REG_TARGET_SET.size ? [...REG_TARGET_SET].join(',') : 'GLOBAL'}`);

  // ワーカーは音楽だけ運用（他モジュールは起動しない）
  if (!IS_TOTORO) return;

  // ===== Totoro only =====

  // Role Sync
  setupRoleSync(client);

  // Birthday notifier (JST 0:00)
  scheduleBirthdayNotifier(client);

  // フリバ募集集計の対象（ギルド→チャンネル/ロール）
  setFreebattleConfig({
    "1259933702381764764": { channelId: "1260037785604198504", roleId: "1275855651003957389" },
    "993960755470794792": { channelId: "1208720170349105223", roleIds: ["1246696197947785250","1359709079651745802"] },
  });

  // イベント購読（アワード / おしゃべり / チーム）
  wireAwardHandlers(client);
  wireChatterHandlers(client);
  wireTeamHandlers(client, { sendToChannel });
  wireDiceHandlers(client);
  wireRoleHandlers(client);
  wireSuggestionHandlers(client);
  initNoticeBoard(client);
}

let readyFired = false;
function onceReadyWrapper() {
  if (readyFired) return;
  readyFired = true;
  onReadyOnce();
}

client.once('clientReady', onceReadyWrapper);
client.once('ready', onceReadyWrapper);

// =========================================================
// Boot
// =========================================================
async function main() {
  // 必須修正①：token欠落を即分かるようにする
  if (!DISCORD_TOKEN) {
    throw new Error(`[env] DISCORD_TOKEN is missing for BOT_PROFILE=${PROFILE}`);
  }

  await client.login(DISCORD_TOKEN);

  // 必須修正②：スラッシュを登録する時だけ、登録対象ギルドを参加済みに間引く
  if (ENABLE_SLASH && REG_TARGET_SET.size > 0) {
    const joined = new Set(client.guilds.cache.map(g => g.id));
    for (const gid of [...REG_TARGET_SET]) {
      if (!joined.has(gid)) {
        console.warn(`[slash] skip ${gid}: bot not in guild (join first)`);
        REG_TARGET_SET.delete(gid);
      }
    }
  }

  // 音楽モジュールへ依存を注入（通知・送信・デバッグ・上限）
  installMusicModule({
    client,
    shoukaku,
    sendNotice,
    sendToChannel,
    debugResolve: DEBUG_RESOLVE,
    maxQueue: MAX_QUEUE
  });
  wireMusicHandlers(client);

  // =========================================================
  // Worker RPC server (nakatoro/kototoro only)
  // =========================================================
    if (!IS_TOTORO) {
    const port = Number(process.env.WORKER_RPC_PORT ?? 8787);
    const token = String(process.env.WORKER_RPC_TOKEN ?? '');

    startWorkerRpcServer({
      port,
      token,
      getStatus: getRpcStatus,
      handlers: {
        '/rpc/music/play':  rpcPlay,
        '/rpc/music/skip':  rpcSkip,
        '/rpc/music/leave': rpcLeave,
        '/rpc/music/queue': rpcQueue,
        '/rpc/music/loop':       rpcLoop,
        '/rpc/music/loop_queue': rpcLoopQueue,
        '/rpc/music/shuffle':    rpcShuffle,
      }
    });

    console.log(`[worker-rpc] enabled on :${port}`);
  }


  // スラッシュ登録（Totoroのみ。将来ワーカーは ENABLE_SLASH=1 でON可）
  if (ENABLE_SLASH) {
    await registerCommands();
  }
}

main().catch(e => {
  console.error('[boot] failed', e);
  process.exit(1);
});

// =========================================================
// Shoukaku debug logs（任意）
// =========================================================
shoukaku.on('ready', name => console.log(`[Shoukaku] node ${name} ready`));
shoukaku.on('error', (name, error) => console.error(`[Shoukaku] node ${name} error`, error?.message || error));
shoukaku.on('close', (name, code, reason) => console.warn(`[Shoukaku] node ${name} closed`, code, reason?.toString?.()));


/*
cd /home/ubuntu/my-music-bot
sudo docker compose up -d --build bot_totoro bot_nakatoro bot_kototoro
sudo docker compose logs -f --tail=200 bot_totoro bot_nakatoro bot_kototoro

cd /home/ubuntu/my-music-bot
sudo docker compose restart bot_totoro bot_nakatoro bot_kototoro
sudo docker compose logs -f --tail=200 bot_totoro bot_nakatoro bot_kototoro

cd /home/ubuntu/my-music-bot
sudo docker compose up -d lavalink
sudo docker compose logs --tail=100 lavalink
sudo docker compose up -d --build bot_totoro bot_nakatoro bot_kototoro
sudo docker compose logs -f --tail=200 lavalink bot_totoro bot_nakatoro bot_kototoro

cd /home/ubuntu/my-music-bot
sudo docker compose up -d --force-recreate bot_totoro bot_nakatoro bot_kototoro
sudo docker compose logs -f --tail=200 bot_totoro bot_nakatoro bot_kototoro

cd /home/ubuntu/my-music-bot
sudo docker compose down
sudo docker compose up -d --build
sudo docker compose logs -f --tail=200 lavalink bot_totoro bot_nakatoro bot_kototoro


*/
