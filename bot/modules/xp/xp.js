// modules/xp/xp.js
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { openDb, getOrInit, addXp, setMsgCooldown, getMsgCooldown,
         setVcJoin, clearVcJoin, addVcSessionMs, takeVcSessionMs,
         topTotal, topYear, getAllForRank, setDeltaXp, peek } from './store.js';
import { levelFromTotal, xpToNextLevel } from './level.js';
import { computeAwardPoints, remainderMs } from './logic.js';

const MESSAGE_COOLDOWN_MS = 15_000;
const TICK_MS = 60_000; // 1分ごとtick

export function buildXpCommands() {
  return [
    // 誰でも見える・使える（ただし他人指定は管理者のみ。ハンドラで既に防御済み）
    new SlashCommandBuilder()
      .setName('totoro_exp')
      .setDescription('累計XP/レベル（＋管理者は他人も確認可）')
      .addUserOption(o => o.setName('user').setDescription('確認したいユーザー（管理者のみ）'))
      .setDMPermission(false) // サーバ専用にしたい場合
      .toJSON(),

    // 管理者のみ “見える/使える”
    new SlashCommandBuilder()
      .setName('totoro_exp_rank')
      .setDescription('累計XPランキング上位10人')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),

    // 誰でも使える
    new SlashCommandBuilder()
      .setName('totoro_exp_year')
      .setDescription('当年のXPを表示')
      .setDMPermission(false)
      .toJSON(),

    // 管理者のみ “見える/使える”
    new SlashCommandBuilder()
      .setName('totoro_exp_year_rank')
      .setDescription('当年のXPランキング上位10人')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),

    // 管理者のみ “見える/使える”
    new SlashCommandBuilder()
      .setName('totoro_exp_management')
      .setDescription('特定ユーザーのXPを加減算（管理者のみ）')
      .addUserOption(o => o.setName('user').setDescription('対象ユーザー').setRequired(true))
      .addIntegerOption(o => o.setName('delta').setDescription('±n（加算/減算）').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),
  ];
}

export function initXpSystem(client, sendNotice) {
  const db = openDb();
  void sendNotice;
  // ---- message XP (+1 with cooldown) ----
  client.on('messageCreate', (msg) => {
    try {
      if (!msg.guild || msg.author.bot) return;
      const gid = msg.guild.id, uid = msg.author.id;
      const now = Date.now();
      if (getMsgCooldown(db, gid, uid) > now) return;
      getOrInit(db, gid, uid);
      addXp(db, gid, uid, 1);
      setMsgCooldown(db, gid, uid, now + MESSAGE_COOLDOWN_MS);

    } catch (e) { console.warn('[xp:msg]', e?.stack || e); }
  });

  // ---- voice join/leave/move → sessionms更新 ----
  client.on('voiceStateUpdate', async (oldS, newS) => {
    const guild = newS?.guild ?? oldS?.guild;
    if (!guild) return;
    const m = newS?.member ?? oldS?.member;
    if (!m || m.user.bot) return;

    const gid = guild.id, uid = m.id;
    const now = Date.now();
    const wasIn = !!oldS?.channelId;
    const nowIn = !!newS?.channelId;

    // join
    if (!wasIn && nowIn) {
      getOrInit(db, gid, uid);
      setVcJoin(db, gid, uid, now);
      return;
    }
    // leave
    if (wasIn && !nowIn) {
      const row = peek(db, gid, uid);
      if (row.vc_join_ts) {
        addVcSessionMs(db, gid, uid, now - row.vc_join_ts);
        clearVcJoin(db, gid, uid);
      }
      awardFromSession(db, gid, uid, m).catch(()=>{});
      return;
    }
    // move
    if (wasIn && nowIn && oldS.channelId !== newS.channelId) {
      const row = peek(db, gid, uid);
      if (row.vc_join_ts) {
        addVcSessionMs(db, gid, uid, now - row.vc_join_ts);
      }
      setVcJoin(db, gid, uid, now);
      awardFromSession(db, gid, uid, m).catch(()=>{});
    }
  });

  // ---- 1分tickで在室者のセッションを進め、必要なら付与 ----
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const g of client.guilds.cache.values()) {
        for (const ch of g.channels.cache.values()) {
          if (!ch?.isVoiceBased?.()) continue;
          for (const member of ch.members.values()) {
            if (member.user.bot) continue;
            const gid = g.id, uid = member.id;
            const row = getOrInit(db, gid, uid);
            // 参加中なら join_ts があるはず
            const joined = row.vc_join_ts;
            if (joined) {
              // ★ 直近tickからの“実際の経過時間”を積む
              const delta = now - joined;
              if (delta > 0) {
                addVcSessionMs(db, gid, uid, delta);
                // ★ 基準時刻を“今”へ更新（これでleave/move時は端数分だけ加算される）
                setVcJoin(db, gid, uid, now);
              }
              await awardFromSession(db, gid, uid, member);
            }
          }
        }
      }
    } catch (e) { console.warn('[xp:tick]', e?.stack || e); }
  }, TICK_MS);

  // ---- slash handler ----
  async function handleSlash(i) {
    const gid = i.guildId;
    if (i.commandName === 'totoro_exp') {
      const target = i.options.getUser('user') ?? i.user;
      const forOthers = target.id !== i.user.id;
      if (forOthers && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ他人のXPを確認できます。', ephemeral: true });
      }
      const row = peek(db, gid, target.id);
      const total = row.total_xp || 0;
      const year = row.year_xp || 0;
      const lv = levelFromTotal(total);
      const toNext = xpToNextLevel(total);
      // 順位（累計）
      const all = getAllForRank(db, gid);
      const rank = all.findIndex(r => r.user_id === target.id) + 1 || all.length || 0;

      const embed = new EmbedBuilder()
        .setTitle('経験値（累計 / 当年）')
        .setDescription(`<@${target.id}>`)
        .addFields(
          { name: '累計XP', value: String(total), inline: true },
          { name: '当年XP', value: String(year), inline: true },
          { name: 'レベル', value: `Lv.${lv}（次まで ${toNext}）`, inline: false },
          { name: '累計ランキング', value: rank ? `#${rank} / ${all.length}` : 'データなし', inline: false }
        );
      return i.reply({ embeds: [embed] });
    }

    if (i.commandName === 'totoro_exp_rank') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const top = topTotal(db, gid, 10);
      if (top.length === 0) return i.reply({ content: 'まだデータがないよ！', ephemeral: true });
      const lines = top.map((r, idx) => `${idx + 1}. <@${r.user_id}> — **${r.total_xp} XP** (Lv.${levelFromTotal(r.total_xp)})`);
      return i.reply({ content: `🏆 **累計XPランキング**\n${lines.join('\n')}` });
    }

    if (i.commandName === 'totoro_exp_year') {
      const row = peek(db, gid, i.user.id);
      return i.reply({ content: `📅 **当年XP**：${row.year_xp || 0}` });
    }

    if (i.commandName === 'totoro_exp_year_rank') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const top = topYear(db, gid, 10);
      if (top.length === 0) return i.reply({ content: 'まだデータがないよ！', ephemeral: true });
      const lines = top.map((r, idx) => `${idx + 1}. <@${r.user_id}> — **${r.year_xp} XP**`);
      return i.reply({ content: `🏆 **当年XPランキング**\n${lines.join('\n')}` });
    }

    if (i.commandName === 'totoro_exp_management') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const target = i.options.getUser('user', true);
      const delta = i.options.getInteger('delta', true);
      const { total_xp, year_xp } = setDeltaXp(db, gid, target.id, delta);
      return i.reply({ content: `🛠️ <@${target.id}> に ${delta} XP を反映しました（累計:${total_xp} / 当年:${year_xp}）。` });
    }

    return false;
  }

  // ---- VCセッションから付与する本体 ----
  async function awardFromSession(db, gid, uid, memberObj) {
    const v = memberObj?.voice;
    const isDeaf = !!(v?.selfDeaf || v?.serverDeaf);
    const isMuted = !!(v?.selfMute || v?.serverMute);
    const mult = isDeaf ? 0 : (isMuted ? 1 : 2);
    const allMs = takeVcSessionMs(db, gid, uid); // 合計msを取り出して0に
    const points = computeAwardPoints(0, allMs, mult);
    // 端数msは残す（次回へ持ち越し）
    const rateMsTail = remainderMs(allMs);
    if (rateMsTail > 0) addVcSessionMs(db, gid, uid, rateMsTail);

    if (points > 0) {
      addXp(db, gid, uid, points);
    }
  }

  return { handleSlash };
}
