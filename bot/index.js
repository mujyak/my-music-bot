// index.js — Totoro-bot core (music module extracted)
// 目的: 起動・環境変数読込・スラッシュ登録・各モジュールと配線を一元管理するエントリポイント

// ===== Imports =====
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  AuditLogEvent
} from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';

// XPモジュール（XPコマンドのビルドとハンドラ作成）
import { initXpSystem, buildXpCommands } from './modules/xp/xp.js';

// 誕生日通知（JST 0:00 に送信するスケジューラ）
import { scheduleBirthdayNotifier } from './modules/birthday/notifier.js';

// アワード（寝落ち/フリバ）機能のスラッシュ定義・イベント配線
import { buildAwardCommands, wireAwardHandlers, dispatchAwardInteraction, setFreebattleConfig } from "./modules/awards/index.js";

import { wireChatterHandlers } from "./modules/chatter/index.js";

// 音楽モジュール（依存注入・コマンド・イベント配線）
import {
  installMusicModule,
  buildMusicCommands,
  wireMusicHandlers,
  dispatchMusicInteraction
} from './modules/music/index.js';

// ===== Env =====
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  ALLOW_GUILDS,
  LAVALINK_PASSWORD,
  NOTICE_CHANNEL_ID,
  TOTORO_DEBUG_RESOLVE // '1' で音楽解決ログON
} = process.env;

// 文字列を配列化する補助（カンマ/空白区切り対応）
function splitList(v) {
  return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
const ALLOW_SET = new Set(splitList(ALLOW_GUILDS));                      // 利用許可ギルド（空なら全許可）
const REG_TARGET_SET = new Set([...splitList(GUILD_ID), ...ALLOW_SET]);  // スラッシュ登録先ギルド
const DEBUG_RESOLVE = TOTORO_DEBUG_RESOLVE === '1';

// ===== Constants =====
const MAX_QUEUE = 10;

// ===== Lavalink Nodes =====
const NODES = [
  { name: 'main', url: 'lavalink:2333', auth: LAVALINK_PASSWORD, secure: false }
];

// ===== Slash Commands (音楽以外) =====
const coreCommands = [
  ...buildXpCommands(),
  ...buildAwardCommands(),
];

// ===== Discord Client & Shoukaku =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), NODES, {
  moveOnDisconnect: false,
  resumable: true,
  resumableTimeout: 60
});

// ===== Allowlist: ギルド参加時のフィルタ =====
function isAllowedGuild(gid) {
  return ALLOW_SET.size === 0 || ALLOW_SET.has(String(gid));
}

client.on('guildCreate', guild => {
  if (!isAllowedGuild(guild.id)) {
    console.log(`[ALLOWLIST] not allowed guild ${guild.id} (${guild.name}) -> leaving`);
    guild.leave().catch(() => {});
  }
});

// ===== Notice Helpers (音楽/XPの通知先選択) =====
// 関数: 通知チャンネルを選ぶ（VCテキスト > 固定ID > システム/送信可能テキスト）
async function findNoticeChannel(guild) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe();

    // 1) 今いるVCのテキストチャットを最優先
    const vcId = me?.voice?.channelId;
    if (vcId) {
      const vc = guild.channels.cache.get(vcId) ?? await guild.channels.fetch(vcId).catch(() => null);
      const isTextLike =
        (typeof vc?.isTextBased === 'function' && vc.isTextBased()) ||
        vc?.type === ChannelType.GuildVoice;
      const canSend =
        vc?.viewable &&
        vc?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
      if (isTextLike && canSend) {
        return vc;
      }
    }

    // 2) 固定チャンネルIDがあれば次点
    if (NOTICE_CHANNEL_ID) {
      const fixed = guild.channels.cache.get(NOTICE_CHANNEL_ID) ?? await guild.channels.fetch(NOTICE_CHANNEL_ID).catch(() => null);
      if (fixed?.isTextBased?.() && !fixed.isThread?.() && fixed.viewable &&
          fixed.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
        return fixed;
      }
    }

    // 3) フォールバック: システムチャンネル or 送信可能テキスト
    const ch =
      guild.systemChannel ??
      guild.channels.cache.find(c =>
        c?.isTextBased?.() &&
        !c?.isThread?.() &&
        c?.viewable &&
        c?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
      );

    return ch ?? null;
  } catch {
    return null;
  }
}

// ギルドの適切な通知チャンネルにメッセージを送る（失敗しても落とさない）
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

// 任意のチャンネルIDへ直接送る（送信可否を権限チェック）
async function sendToChannel(gid, channelId, content) {
  try {
    const guild = client.guilds.cache.get(gid);
    if (!guild) return false;
    const ch = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return false;
    const me = guild.members.me ?? await guild.members.fetchMe();

    const isTextLike =
      (typeof ch.isTextBased === 'function' && ch.isTextBased()) ||
      ch.type === ChannelType.GuildVoice;
    const notThread = typeof ch.isThread === 'function' ? !ch.isThread() : true;
    const perms = ch.permissionsFor(me);
    const canSend =
      ch.viewable &&
      perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms?.has(PermissionFlagsBits.SendMessages);

    if (isTextLike && notThread && canSend) {
      await ch.send(content);
      return true;
    }
  } catch (e) {
    console.warn('[sendToChannel]', e?.message || e);
  }
  return false;
}

// ===== Interactions (スラッシュ分岐) =====
const xp = initXpSystem(client, (gid, content) => sendNotice(gid, content));

client.on('interactionCreate', async i => {
  try {
    if (!i.isChatInputCommand()) return;
    if (!isAllowedGuild(i.guildId)) {
      return i.reply({ content: 'このサーバでは利用許可がありません。', ephemeral: true });
    }

    // 1) XPコマンドへ委譲
    if (['totoro_exp','totoro_exp_rank','totoro_exp_year','totoro_exp_year_rank','totoro_exp_management'].includes(i.commandName)) {
      const handled = await xp.handleSlash?.(i);
      if (handled !== false) return;
    }

    // 2) 音楽コマンドへ委譲
    const handledMusic = await dispatchMusicInteraction(i);
    if (handledMusic) return;

    // 3) アワード（寝落ち/フリバ）コマンドへ委譲
    const handledAwards = await dispatchAwardInteraction(i);
    if (handledAwards) return;

    // 4) その他（将来拡張）
  } catch (e) {
    console.error('[interaction] failed:', e);
    try {
      if (i.deferred) await i.editReply('エラーが起きたみたい…ログを見てみてね。');
      else await i.reply({ content: 'エラーが起きたみたい…', ephemeral: true });
    } catch {}
  }
});

// ===== Command Registration =====
async function registerCommands() {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required');
  if (!CLIENT_ID) throw new Error('CLIENT_ID is required');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  const commands = [
    ...buildMusicCommands(),
    ...coreCommands
  ];

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

// ===== Boot =====
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`[allow] ALLOW_GUILDS: ${ALLOW_SET.size ? [...ALLOW_SET].join(',') : '(not set = all allowed)'}`);
  console.log(`[slash] target: ${REG_TARGET_SET.size ? [...REG_TARGET_SET].join(',') : 'GLOBAL'}`);

  // 誕生日通知（JST 0:00に投稿）
  scheduleBirthdayNotifier(client);

  // フリバ募集集計の対象（ギルド→チャンネル/ロール）
  setFreebattleConfig({
    "1259933702381764764": { channelId: "1260037785604198504", roleId: "1275855651003957389" },
    // "本番ギルドID": { channelId: "本番チャンネルID", roleId: "本番ロールID" },
  });

  // アワード機能（寝落ち検知・フリバ集計）のイベント購読
  wireAwardHandlers(client);
  wireChatterHandlers(client);
});

async function main() {
  await client.login(DISCORD_TOKEN);

  // スラッシュ登録対象の健全性チェック（Botが未参加のギルドは登録スキップ）
  if (REG_TARGET_SET.size > 0) {
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

  // スラッシュ登録
  await registerCommands();
}

// 起動
main().catch(e => {
  console.error('[boot] failed', e);
  process.exit(1);
});

// ===== Shoukaku debug logs (optional) =====
shoukaku.on('ready', name => console.log(`[Shoukaku] node ${name} ready`));
shoukaku.on('error', (name, error) => console.error(`[Shoukaku] node ${name} error`, error?.message || error));
shoukaku.on('close', (name, code, reason) => console.warn(`[Shoukaku] node ${name} closed`, code, reason?.toString?.()));
