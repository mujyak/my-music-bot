// index.js — Totoro-bot core
// 目的: 起動・環境変数読込・スラッシュ登録・各モジュールを一元配線するエントリポイント

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

// XPモジュール
import { initXpSystem, buildXpCommands } from './modules/xp/xp.js';

// 誕生日通知（JST 0:00）
import { scheduleBirthdayNotifier } from './modules/birthday/notifier.js';

// アワード（寝落ち/フリバ）
import {
  buildAwardCommands,
  wireAwardHandlers,
  dispatchAwardInteraction,
  setFreebattleConfig
} from './modules/awards/index.js';

// おしゃべり
import { wireChatterHandlers } from './modules/chatter/index.js';

// チーム分け（リアクション募集＋NGペア回避）
import { buildTeamsCommands, wireTeamHandlers } from './modules/teams/index.js';

import { buildDiceCommands, wireDiceHandlers } from './modules/dice/index.js';

import {
  buildGachaCommands,
  handleGachaSlash,
  dispatchGachaInteraction
} from './modules/gacha/index.js';

import { wireRoleHandlers } from './modules/roles/index.js';


// 音楽（Shoukaku）
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

// ===== Helpers =====
function splitList(v) {
  return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
const ALLOW_SET = new Set(splitList(ALLOW_GUILDS));                      // 利用許可ギルド（空=全許可）
const REG_TARGET_SET = new Set([...splitList(GUILD_ID), ...ALLOW_SET]);  // スラッシュ登録対象
const DEBUG_RESOLVE = TOTORO_DEBUG_RESOLVE === '1';

// ===== Constants =====
const MAX_QUEUE = 100;

// ===== Lavalink Nodes =====
const NODES = [
  { name: 'main', url: 'lavalink:2333', auth: LAVALINK_PASSWORD, secure: false }
];

// ===== Slash Commands (音楽以外) =====
const coreCommands = [
  ...buildXpCommands(),
  ...buildAwardCommands(),
  ...buildTeamsCommands(),
  ...buildDiceCommands(),
  ...buildGachaCommands()
];

// ===== Discord Client & Shoukaku =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, // リアクション収集に必須
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

// ===== Notice Helpers（安全: テキストチャンネル限定） =====

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
      c.type !== ChannelType.GuildAnnouncement // ここは除外（権限が厳しいことが多い）
    );

    return ch ?? null;
  } catch {
    return null;
  }
}

// ギルドの適切な通知チャンネルにメッセージ送信（失敗しても落とさない）
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

// ===== Interactions（スラッシュ分岐） =====
const xp = initXpSystem(client, (gid, content) => sendNotice(gid, content));

client.on('interactionCreate', async i => {
  try {
    // ---- 利用許可ギルドチェック（共通） ----
    if (i.guildId && !isAllowedGuild(i.guildId)) {
      if (i.isChatInputCommand()) {
        // スラッシュコマンドは一応メッセージを返す
        return i.reply({
          content: 'このサーバでは利用許可がありません。',
          ephemeral: true
        });
      }
      // ボタンやセレクトは黙って無視
      return;
    }

    // ---- ① ガチャのボタン / セレクト処理 ----
    // （このリスナーは今までボタンを完全無視していたので、
    //  他モジュールとの競合は発生しない想定）
    if (i.isButton() || i.isStringSelectMenu()) {
      const handledGacha = await dispatchGachaInteraction(i);
      if (handledGacha) return;
      // ここでは他のボタンは触らず、そのまま return して終了。
      // 他モジュール（teams / awards など）は wireXXXHandlers 内で
      // 自前の interactionCreate リスナーを持っているので、
      // そっちが処理してくれる。
      return;
    }

    // ---- ② ここからスラッシュコマンドだけを見る ----
    if (!i.isChatInputCommand()) return;

    // 2-1) XPコマンド
    if ([
      'totoro_exp',
      'totoro_exp_rank',
      'totoro_exp_year',
      'totoro_exp_year_rank',
      'totoro_exp_management'
    ].includes(i.commandName)) {
      const handled = await xp.handleSlash?.(i);
      if (handled !== false) return;
    }

    // 2-2) 音楽コマンド
    const handledMusic = await dispatchMusicInteraction(i);
    if (handledMusic) return;

    // 2-3) アワード（寝落ち / フリバ）
    const handledAwards = await dispatchAwardInteraction(i);
    if (handledAwards) return;

    // 2-4) ガチャスラッシュコマンド
    // ※ /totoro_gacha 以外なら false が返ってそのままスルーされる
    const handledGachaSlash = await handleGachaSlash(i);
    if (handledGachaSlash) return;

    // 2-5) その他は各モジュールの wire 側（例：teams）が拾う
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


// ===== Command Registration =====
async function registerCommands() {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required');
  if (!CLIENT_ID) throw new Error('CLIENT_ID is required');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    ...buildMusicCommands(),
    ...coreCommands, // XP / Awards / Teams
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

// ===== Ready （互換: ready / clientReady のどちらでも一度だけ） =====
function onReadyOnce() {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`[allow] ALLOW_GUILDS: ${ALLOW_SET.size ? [...ALLOW_SET].join(',') : '(not set = all allowed)'}`);
  console.log(`[slash] target: ${REG_TARGET_SET.size ? [...REG_TARGET_SET].join(',') : 'GLOBAL'}`);

  // 誕生日通知（JST 0:00）
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
}

let readyFired = false;
function onceReadyWrapper() {
  if (readyFired) return;
  readyFired = true;
  onReadyOnce();
}

client.once('clientReady', onceReadyWrapper);

// ===== Boot =====
async function main() {
  await client.login(DISCORD_TOKEN);

  // スラッシュ登録対象の健全性チェック（Bot未参加ギルドは登録スキップ）
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

main().catch(e => {
  console.error('[boot] failed', e);
  process.exit(1);
});

// ===== Shoukaku debug logs（任意） =====
shoukaku.on('ready', name => console.log(`[Shoukaku] node ${name} ready`));
shoukaku.on('error', (name, error) => console.error(`[Shoukaku] node ${name} error`, error?.message || error));
shoukaku.on('close', (name, code, reason) => console.warn(`[Shoukaku] node ${name} closed`, code, reason?.toString?.()));
