// modules/suggestions/interactions.js
//
// トトロ目安箱の interaction 処理本体。
// - 目安箱ボタンが押されたらモーダルを表示
// - モーダル送信を受け取ったらDB保存
// - 運営確認チャンネルへEmbedで通知
//
// モーダル入力欄：
// - タイトル
// - 本文

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { getSuggestionGuildConfig } from './config.js';

import {
  createSuggestion,
  setSuggestionStaffMessageId,
} from './store.js';

export const SUGGESTION_BUTTON_CUSTOM_ID = 'suggestions:open';
export const SUGGESTION_MODAL_CUSTOM_ID = 'suggestions:submit';

const TITLE_INPUT_ID = 'suggestions:title';
const CONTENT_INPUT_ID = 'suggestions:content';

/**
 * 窓口メッセージ投稿スクリプト側でも使える、目安箱ボタンを作る関数。
 *
 * @param {object} options
 * @param {string} [options.label]
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildSuggestionButtonRow(options = {}) {
  const label = options.label || 'トトロに預ける';

  const button = new ButtonBuilder()
    .setCustomId(SUGGESTION_BUTTON_CUSTOM_ID)
    .setLabel(label)
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * この interaction が目安箱関連かどうか判定する。
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
export function isSuggestionInteraction(interaction) {
  if (!interaction) return false;

  if (interaction.isButton?.()) {
    return interaction.customId === SUGGESTION_BUTTON_CUSTOM_ID;
  }

  if (interaction.isModalSubmit?.()) {
    return interaction.customId === SUGGESTION_MODAL_CUSTOM_ID;
  }

  return false;
}

/**
 * 目安箱関連の interaction を処理する。
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {object} options
 */
export async function handleSuggestionInteraction(interaction, options = {}) {
  if (interaction.isButton?.()) {
    if (interaction.customId === SUGGESTION_BUTTON_CUSTOM_ID) {
      await handleOpenSuggestionModal(interaction, options);
      return;
    }
  }

  if (interaction.isModalSubmit?.()) {
    if (interaction.customId === SUGGESTION_MODAL_CUSTOM_ID) {
      await handleSubmitSuggestionModal(interaction, options);
      return;
    }
  }
}

/**
 * 目安箱ボタンが押されたとき、入力モーダルを表示する。
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} options
 */
async function handleOpenSuggestionModal(interaction, options = {}) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'この目安箱はサーバー内でのみ使えます。',
      ephemeral: true,
    });
    return;
  }

  const guildConfig = getSuggestionGuildConfig(interaction.guildId, options);

  if (!guildConfig) {
    await interaction.reply({
      content: 'このサーバーでは目安箱機能が有効になっていません。',
      ephemeral: true,
    });
    return;
  }

  if (!guildConfig.staffChannelId) {
    await interaction.reply({
      content: '目安箱の運営確認チャンネルが設定されていません。',
      ephemeral: true,
    });
    return;
  }

  if (
    guildConfig.boxChannelId &&
    interaction.channelId &&
    interaction.channelId !== guildConfig.boxChannelId
  ) {
    await interaction.reply({
      content: 'この目安箱ボタンは、設定された窓口チャンネルでのみ使えます。',
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(SUGGESTION_MODAL_CUSTOM_ID)
    .setTitle('トトロ目安箱');

  const titleInput = new TextInputBuilder()
    .setCustomId(TITLE_INPUT_ID)
    .setLabel('タイトル')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder('例：VCカテゴリについて');

  const contentInput = new TextInputBuilder()
    .setCustomId(CONTENT_INPUT_ID)
    .setLabel('本文')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder('意見・要望・相談内容などをここに書いてください。');

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(contentInput),
  );

  await interaction.showModal(modal);
}

/**
 * モーダル送信を受け取り、DB保存と運営チャンネル通知を行う。
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {object} options
 */
async function handleSubmitSuggestionModal(interaction, options = {}) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'この目安箱はサーバー内でのみ使えます。',
      ephemeral: true,
    });
    return;
  }

  const guildConfig = getSuggestionGuildConfig(interaction.guildId, options);

  if (!guildConfig) {
    await interaction.reply({
      content: 'このサーバーでは目安箱機能が有効になっていません。',
      ephemeral: true,
    });
    return;
  }

  if (!guildConfig.staffChannelId) {
    await interaction.reply({
      content: '目安箱の運営確認チャンネルが設定されていません。',
      ephemeral: true,
    });
    return;
  }

  const title = interaction.fields.getTextInputValue(TITLE_INPUT_ID).trim();
  const content = interaction.fields.getTextInputValue(CONTENT_INPUT_ID).trim();

  if (!title || !content) {
    await interaction.reply({
      content: 'タイトルと本文の両方を入力してください。',
      ephemeral: true,
    });
    return;
  }

  const staffChannel = await fetchChannel(
    interaction.client,
    guildConfig.staffChannelId,
  );

  if (!isSendableTextChannel(staffChannel)) {
    await interaction.reply({
      content: '運営確認チャンネルへ送信できませんでした。チャンネル設定や権限を確認してください。',
      ephemeral: true,
    });
    return;
  }

  const suggestion = createSuggestion({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    username: getUserName(interaction),
    displayName: getDisplayName(interaction),
    title,
    content,
    staffChannelId: guildConfig.staffChannelId,
  }, options);

  const staffMessage = await staffChannel.send({
    embeds: [
      buildStaffEmbed({
        suggestion,
        user: interaction.user,
      }),
    ],
  });

  setSuggestionStaffMessageId({
    id: suggestion.id,
    guildId: interaction.guildId,
    staffMessageId: staffMessage.id,
  }, options);

  await interaction.reply({
    content: '目安箱に投稿しました。トトロが運営に届けておきます。',
    ephemeral: true,
  });
}

/**
 * 運営確認チャンネルへ送るEmbedを作る。
 *
 * @param {object} input
 * @param {object} input.suggestion
 * @param {import('discord.js').User} input.user
 * @returns {EmbedBuilder}
 */
function buildStaffEmbed({ suggestion, user }) {
  return new EmbedBuilder()
    .setTitle(`📮 目安箱 投稿 #${suggestion.id}`)
    .setDescription(truncateForEmbedDescription(suggestion.content))
    .addFields(
      {
        name: 'タイトル',
        value: truncateForEmbedField(suggestion.title),
      },
      {
        name: '投稿者',
        value: [
          `<@${user.id}>`,
          `ユーザーID: \`${user.id}\``,
          suggestion.displayName
            ? `表示名: \`${escapeBackticks(suggestion.displayName)}\``
            : null,
          suggestion.username
            ? `ユーザー名: \`${escapeBackticks(suggestion.username)}\``
            : null,
        ].filter(Boolean).join('\n'),
      },
      {
        name: '状態',
        value: statusLabel(suggestion.status),
        inline: true,
      },
      {
        name: '投稿日時',
        value: `<t:${toUnixTimestamp(suggestion.createdAt)}:F>`,
        inline: true,
      },
    )
    .setFooter({
      text: `Suggestion ID: ${suggestion.id}`,
    })
    .setTimestamp(new Date(suggestion.createdAt));
}

/**
 * チャンネルIDからチャンネルを取得する。
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @returns {Promise<import('discord.js').Channel | null>}
 */
async function fetchChannel(client, channelId) {
  if (!client || !channelId) return null;

  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;

  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`[suggestions] failed to fetch channel: ${channelId}`, err);
    return null;
  }
}

/**
 * send可能なテキスト系チャンネルかどうか。
 *
 * @param {unknown} channel
 * @returns {boolean}
 */
function isSendableTextChannel(channel) {
  return Boolean(
    channel &&
    channel.isTextBased?.() &&
    typeof channel.send === 'function',
  );
}

/**
 * interactionからユーザー名を取得する。
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {string}
 */
function getUserName(interaction) {
  return (
    interaction.user?.tag ||
    interaction.user?.username ||
    'unknown'
  );
}

/**
 * interactionからサーバー内表示名を取得する。
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {string}
 */
function getDisplayName(interaction) {
  if (
    interaction.member &&
    typeof interaction.member === 'object' &&
    'displayName' in interaction.member &&
    typeof interaction.member.displayName === 'string'
  ) {
    return interaction.member.displayName;
  }

  return (
    interaction.user?.globalName ||
    interaction.user?.username ||
    ''
  );
}

function statusLabel(status) {
  switch (status) {
    case 'pending':
      return '未対応';
    case 'in_progress':
      return '対応中';
    case 'done':
      return '対応済み';
    case 'hold':
      return '保留';
    case 'rejected':
      return '見送り';
    default:
      return status || '未対応';
  }
}

function toUnixTimestamp(isoString) {
  const date = new Date(isoString);
  const time = date.getTime();

  if (!Number.isFinite(time)) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(time / 1000);
}

function truncateForEmbedField(value) {
  const text = String(value ?? '').trim();
  if (text.length <= 1024) return text;
  return `${text.slice(0, 1021)}...`;
}

function truncateForEmbedDescription(value) {
  const text = String(value ?? '').trim();
  if (text.length <= 4096) return text;
  return `${text.slice(0, 4093)}...`;
}

function escapeBackticks(value) {
  return String(value ?? '').replaceAll('`', '｀');
}