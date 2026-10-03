// modules/omikuji/interactions.js
import { EmbedBuilder } from 'discord.js';
import { loadPools, drawOmikuji } from './pools.js';
import { getActiveSeason } from './season.js';
import { hasDrawn, getDrawRecord, setDrawRecord } from './store.js';

function escapeInline(str) {
  // embedの見た目崩れ対策（最低限）
  return String(str ?? '').replace(/`/g, 'ˋ');
}

/**
 * 相性メンバー抽選
 * - 「全メンバー fetch」はギルド規模や回線次第で重く、Interaction 3秒制限の原因になりやすい
 * - まずはキャッシュから選ぶ
 * - キャッシュが薄い場合のみ、短い猶予で fetch を試す（失敗したら諦める）
 */
async function pickRandomGuildMember(guild, excludeUserId) {
  const pickFromCache = () => {
    const members = [...guild.members.cache.values()]
      .filter(m => m && m.user && !m.user.bot)
      .filter(m => m.id !== excludeUserId);

    if (members.length === 0) return null;
    return members[Math.floor(Math.random() * members.length)];
  };

  // 1) まずキャッシュから
  let picked = pickFromCache();
  if (picked) return picked;

  // 2) キャッシュが薄いときだけ、短時間で fetch を試す（重い場合はすぐ諦める）
  try {
    const fetchPromise = guild.members.fetch(); // 大規模だと重いことがある
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('members.fetch timeout')), 1200)
    );
    await Promise.race([fetchPromise, timeoutPromise]);
  } catch {
    // タイムアウト/失敗は無視（相性メンバー無しで続行）
  }

  // 3) もう一度キャッシュから
  return pickFromCache();
}

function buildEmbed({ season, mainLabel, categoryLabels, resultsByCategory, compatMember }) {
  const embed = new EmbedBuilder()
    .setTitle(`🎍 おみくじ（${season}）`)
    .setDescription(`**総合運：${escapeInline(mainLabel)}**`)
    .setTimestamp(new Date());

  for (const { key, label } of categoryLabels) {
    const text = resultsByCategory?.[key] ?? '（未設定）';
    embed.addFields({
      name: label,
      value: escapeInline(text).slice(0, 1024) || '（未設定）',
      inline: false
    });
  }

  // 相性のいいメンバー（メンションしない：<@id> は絶対に使わない）
  if (compatMember) {
    const display = escapeInline(compatMember.displayName ?? compatMember.user.username);
    const uname = escapeInline(compatMember.user.username);
    embed.addFields({
      name: '相性のいいメンバー',
      value: `**${display}**\n(user: \`${uname}\`, id: \`${compatMember.id}\`)`,
      inline: false
    });
  } else {
    embed.addFields({
      name: '相性のいいメンバー',
      value: '（対象メンバーが見つかりませんでした）',
      inline: false
    });
  }

  embed.setFooter({ text: '※ おみくじはギルドごとにシーズン1回まで' });
  return embed;
}

export async function dispatchOmikujiInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'totoro_omikuji') return false;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: 'サーバー内でのみ使えるよ。(　◜ω◝　)',
      ephemeral: true
    });
    return true;
  }

  const gid = guild.id;
  const uid = interaction.user.id;

  // シーズン（=VPSから切り替えるリセット単位）
  const season = getActiveSeason(gid);

  // 既に引いていたら止める（season単位）
  if (hasDrawn(gid, uid, season)) {
    const rec = getDrawRecord(gid, uid, season);
    const when = rec?.at ? `（記録: ${rec.at}）` : '';
    await interaction.reply({
      content: `このシーズン（${season}）はもう引けないよ！${when}`,
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  // ★重要：ここで先に defer して「応答しませんでした」を防ぐ
  // （以降の処理が少し重くても editReply で返せる）
  await interaction.deferReply({ ephemeral: false });

  try {
    // 抽選
    const poolsData = loadPools();
    const drawn = drawOmikuji(poolsData);

    // 相性メンバー（メンションしない）
    const compatMember = await pickRandomGuildMember(guild, uid);

    // カテゴリ表示ラベル
    const categoryLabels = (poolsData.categories ?? []).map(c => ({
      key: c.key,
      label: c.label
    }));

    // Embed生成
    const embed = buildEmbed({
      season,
      mainLabel: drawn.mainLabel,
      categoryLabels,
      resultsByCategory: drawn.resultsByCategory,
      compatMember
    });

    // 保存（season単位で1回制限）
    setDrawRecord(gid, uid, season, {
      at: new Date().toISOString(),
      season,
      mainKey: drawn.mainKey,
      mainLabel: drawn.mainLabel,
      resultsByCategory: drawn.resultsByCategory,
      compatUserId: compatMember?.id ?? null
    });

    await interaction.editReply({
      embeds: [embed],
      allowedMentions: { parse: [] } // embed内も含めてメンション抑止
    });

    return true;
  } catch (e) {
    // defer後なので reply ではなく editReply
    await interaction.editReply({
      content: 'おみくじの処理中にエラーが起きたみたい…（JSONやログを確認してね）',
      allowedMentions: { parse: [] }
    });
    // ログに詳細を出したいならここで console.error してOK
    console.error('[omikuji] failed:', e?.stack || e);
    return true;
  }
}
