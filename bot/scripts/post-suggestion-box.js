// scripts/post-suggestion-box.js
//
// トトロ目安箱の窓口メッセージを投稿するCLIスクリプト。
//
// 使い方:
//   node scripts/post-suggestion-box.js
//
// ギルドを明示する場合:
//   node scripts/post-suggestion-box.js <guildId>
//
// Docker上で実行する例:
//   sudo docker compose exec bot_totoro node scripts/post-suggestion-box.js
//
// data/suggestions/config.json を読み、対象ギルドの boxChannelId に
// ボタン付きの目安箱メッセージを投稿する。

import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
} from 'discord.js';

import { loadSuggestionConfig } from '../modules/suggestions/config.js';
import { buildSuggestionButtonRow } from '../modules/suggestions/interactions.js';

// ===== ここを好きな文章に変えてOK =====

const BOX_MESSAGE_TITLE = 'Hopes.ギルドお悩み相談箱';

const BOX_MESSAGE_DESCRIPTION = [
  'Hopes.ギルド運営への意見・要望・相談などがあれば、こちらから送ってください！',
  '',
  '投稿された内容は運営陣全員のみが見れるチャンネルへ送信されます。',
].join('\n');

const BOX_BUTTON_LABEL = '相談箱に投稿する';

// ====================================

async function main() {
  const token = resolveBotToken();

  if (!token) {
    throw new Error(
      'Bot token が見つかりません。DISCORD_TOKEN または TOTORO_DISCORD_TOKEN / TOTORO_TOKEN などを確認してください。',
    );
  }

  const config = loadSuggestionConfig({ reload: true });
  const guildId = resolveTargetGuildId(config);

  if (!guildId) {
    throw new Error(
      '対象ギルドを特定できませんでした。config.json に有効なギルドを1つだけ設定するか、引数で guildId を指定してください。',
    );
  }

  const guildConfig = config.guilds?.[guildId];

  if (!guildConfig?.enabled) {
    throw new Error(`目安箱機能が有効ではありません: guildId=${guildId}`);
  }

  if (!guildConfig.boxChannelId) {
    throw new Error(`boxChannelId が設定されていません: guildId=${guildId}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
    ],
  });

  client.once('clientReady', async () => {
    try {
      console.log(`[suggestions] logged in as ${client.user.tag}`);

      const channel = await fetchChannel(client, guildConfig.boxChannelId);

      if (!isSendableTextChannel(channel)) {
        throw new Error(
          `窓口チャンネルへ送信できません。チャンネルIDや権限を確認してください: ${guildConfig.boxChannelId}`,
        );
      }

      const sent = await channel.send({
        embeds: [
          buildBoxEmbed(),
        ],
        components: [
          buildSuggestionButtonRow({
            label: BOX_BUTTON_LABEL,
          }),
        ],
      });

      console.log('[suggestions] suggestion box message posted');
      console.log(`guildId: ${guildId}`);
      console.log(`channelId: ${channel.id}`);
      console.log(`messageId: ${sent.id}`);
    } finally {
      client.destroy();
    }
  });

  await client.login(token);
}

function buildBoxEmbed() {
  return new EmbedBuilder()
    .setTitle(BOX_MESSAGE_TITLE)
    .setDescription(BOX_MESSAGE_DESCRIPTION);
}

function resolveTargetGuildId(config) {
  const argGuildId = process.argv[2]?.trim();

  if (argGuildId) {
    return argGuildId;
  }

  const enabledGuildIds = Object.entries(config.guilds || {})
    .filter(([, guildConfig]) => guildConfig?.enabled !== false)
    .map(([guildId]) => guildId);

  if (enabledGuildIds.length === 1) {
    return enabledGuildIds[0];
  }

  return null;
}

function resolveBotToken() {
  const profile = normalizeProfile(process.env.BOT_PROFILE);

  const candidates = [];

  if (profile === 'totoro') {
    candidates.push(
      process.env.TOTORO_DISCORD_TOKEN,
      process.env.TOTORO_TOKEN,
    );
  } else if (profile === 'nakatoro') {
    candidates.push(
      process.env.NAKATORO_DISCORD_TOKEN,
      process.env.NAKATORO_TOKEN,
    );
  } else if (profile === 'kototoro') {
    candidates.push(
      process.env.KOTORO_DISCORD_TOKEN,
      process.env.KOTORO_TOKEN,
      process.env.KOTOTORO_DISCORD_TOKEN,
      process.env.KOTOTORO_TOKEN,
    );
  }

  candidates.push(
    process.env.DISCORD_TOKEN,
    process.env.BOT_TOKEN,
  );

  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function normalizeProfile(value) {
  const raw = String(value || 'totoro')
    .trim()
    .toLowerCase();

  if (raw === 'naka' || raw === 'nakatoro' || raw === 'chutotoro') {
    return 'nakatoro';
  }

  if (
    raw === 'ko' ||
    raw === 'kotoro' ||
    raw === 'kototoro' ||
    raw === 'chibitotoro'
  ) {
    return 'kototoro';
  }

  return 'totoro';
}

async function fetchChannel(client, channelId) {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;

  return await client.channels.fetch(channelId);
}

function isSendableTextChannel(channel) {
  return Boolean(
    channel &&
    channel.isTextBased?.() &&
    typeof channel.send === 'function',
  );
}

main().catch((err) => {
  console.error('[suggestions] failed to post suggestion box message:', err);
  process.exitCode = 1;
});