import {
   ActionRowBuilder, ButtonBuilder, ButtonStyle,
   EmbedBuilder, PermissionFlagsBits, MessageFlags
 } from 'discord.js';
import { buildTeamCommands } from './commands.js';
import { loadNgPairs } from './store.js';
import { splitIntoTeams } from './logic.js';

const REACTION_EMOJI = '🎮';
const COLLECT_MS = 180_000; // 180秒（3分）
const CUSTOM_ID_CLOSE_PREFIX = 'teams:close:';

export function buildTeamsCommands() {
  return buildTeamCommands();
}

// メイン配線
export function wireTeamHandlers(client, { sendToChannel }) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'totoro_team') {
        await handleTeamSlash(interaction);
      } else if (interaction.isButton() && interaction.customId?.startsWith(CUSTOM_ID_CLOSE_PREFIX)) {
        await handleCloseButton(interaction);
      }
    } catch (e) {
      // エラーメッセージは最小限（参加者に影響を与えない）
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

async function handleTeamSlash(interaction) {
  const size = interaction.options.getInteger('size', true);
  if (size < 1) return interaction.reply({ content: 'size は 1 以上にしてください。', ephemeral: true });

  const adminLike = hasAdminLike(interaction.member);
  const hereText = adminLike ? '@here ' : '';
  const allowed = adminLike ? { parse: ['everyone'] } : { parse: [] };

  // 募集メッセージ（Botが 🎮 を付ける）
  const embed = new EmbedBuilder()
    .setTitle('チーム分け参加者募集')
    .setDescription([
      `${hereText}このメッセージに **${REACTION_EMOJI}** でリアクションした人を、\`${size}\` 人ずつのチームにランダム分割します！`,
      `**${Math.floor(COLLECT_MS/1000)}秒後**に自動で締め切ります。主催者は「締め切る」ボタンでも即時締切できます。`,
    ].join('\n'));

  // 締切ボタン（主催者: 実行者のみ有効扱いにする）
  const closeBtn = new ButtonBuilder()
    .setCustomId(CUSTOM_ID_CLOSE_PREFIX + interaction.id) // この slash 実行専用
    .setLabel('締め切る（主催者）')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(closeBtn);

  await interaction.reply({
   content: adminLike ? '@here' : undefined,
   allowedMentions: allowed,
   embeds: [embed],
   components: [row]
 });

  const msg = await interaction.fetchReply().catch(() => null);
  if (!msg) return;

  // Bot 自身でリアクションを付与して分かりやすく
  await msg.react(REACTION_EMOJI).catch(() => {});

  // 収集
  const collector = msg.createReactionCollector({
    time: COLLECT_MS,
    dispose: false
  });

  const participants = new Set();

  const onCollect = async (reaction, user) => {
    try {
      if (reaction.emoji.name !== REACTION_EMOJI) return;
      if (user.bot) return;
      participants.add(user.id);
    } catch {}
  };
  const onRemove = async (reaction, user) => {
    try {
      if (reaction.emoji.name !== REACTION_EMOJI) return;
      if (user.bot) return;
      participants.delete(user.id);
    } catch {}
  };

  collector.on('collect', onCollect);
  collector.on('remove', onRemove);

  // ボタンからの即時締切用に、実行コンテキストを保存
  pending.set(interaction.id, {
    msgId: msg.id,
    channelId: msg.channelId,
    guildId: interaction.guildId,
    ownerId: interaction.user.id,
    participants,
    size,
    collector
  });

  collector.on('end', async (_collected, reason) => {
    // ボタンで手動締切したときは 'manual' を理由に止める → 二重実行を回避
    if (reason === 'manual') return;
    await finalizeTeams(interaction, Array.from(participants), size).catch(() => {});
    pending.delete(interaction.id);
    // ボタン無効化
    disableCloseButton(msg, CUSTOM_ID_CLOSE_PREFIX + interaction.id).catch(() => {});
  });
}

const pending = new Map(); // key: slashInteractionId -> {msgId,channelId,...}

async function handleCloseButton(interaction) {
  // 実行者のみ有効（主催者限定）
  const key = interaction.customId.replace(CUSTOM_ID_CLOSE_PREFIX, '');
  const st = pending.get(key);
  if (!st) return interaction.reply({ content: 'すでに締め切り済み、または無効です。', ephemeral: true });

  if (interaction.user.id !== st.ownerId && !hasAdminLike(interaction.member)) {
    return interaction.reply({ content: 'このボタンは主催者または管理者のみ使えます。', flags: MessageFlags.Ephemeral });
  }

  try { st.collector?.stop?.('manual'); } catch {}

  // 対応メッセージのボタンを無効化
  const channel = await interaction.client.channels.fetch(st.channelId).catch(() => null);
  const msg = channel ? await channel.messages.fetch(st.msgId).catch(() => null) : null;
  if (msg) await disableCloseButton(msg, interaction.customId).catch(() => {});

  // そのまま確定
  await interaction.reply({ content: '募集を締め切りました。チーム分けを実行します…', flags: MessageFlags.Ephemeral }).catch(() => {});
  await finalizeTeams(interaction, Array.from(st.participants), st.size).catch(() => {});
  pending.delete(key);
}

async function disableCloseButton(msg, customId) {
  if (!msg?.editable && !msg?.components?.length) return;
  const rows = msg.components.map(r => {
    const nr = ActionRowBuilder.from(r);
    nr.components = r.components.map(c => {
      const b = ButtonBuilder.from(c);
      if (b.data.custom_id === customId) b.setDisabled(true);
      return b;
    });
    return nr;
  });
  await msg.edit({ components: rows });
}

function hasAdminLike(member) {
  if (!member) return false;
  const p = member.permissions;
  if (!p) return false;
  return p.has(PermissionFlagsBits.Administrator) || p.has(PermissionFlagsBits.ManageGuild);
}

async function finalizeTeams(contextInteraction, participantIds, size) {
  // NGペア読込（絶対に公開しない）
  const ngPairs = loadNgPairs();

  // 分割（NGは可能な範囲で回避。不可なら静かに同チームも許容）
  const { teams } = splitIntoTeams(participantIds, size, ngPairs);

  // 表示（公開）：メンション列挙（allowedMentionsはusersのみ）
  if (teams.length === 0) {
    await contextInteraction.followUp({ content: '参加者がいなかったため中止します。', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const lines = [];
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    if (!t.length) continue;
    const mentions = t.map(id => `<@${id}>`).join(' ');
    lines.push(`**チーム ${i + 1}** (${t.length}人): ${mentions}`);
  }
  const embed = new EmbedBuilder()
    .setTitle('チーム分け結果')
    .setDescription(lines.join('\n'));

  await contextInteraction.followUp({
    embeds: [embed],
    allowedMentions: { users: participantIds, parse: [] } // usersのみ
  }).catch(() => {});
}
