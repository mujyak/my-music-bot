// modules/xp/xp.js
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import {
  openDb, getOrInit, addXp, setMsgCooldown, getMsgCooldown,
  setVcJoin, clearVcJoin, addVcSessionMs, takeVcSessionMs,
  topTotal, topYear, getAllForRank, setDeltaXp, peek,
  setVcAwardedMs, getVcAwardedMs, setDeltaYearXp,
} from './store.js';
import { levelFromTotal, xpToNextLevel } from './level.js';
import { computeAwardPoints, remainderMs } from './logic.js';

const MESSAGE_COOLDOWN_MS = 15_000;
const TICK_MS = 60_000; // 1分ごとtick

// ================================
// 称号ロール（レベル連動）設定
// ================================
// ※この機能を動かすギルドは「1つだけ」
// ※ここが未設定なら何もしない（安全）
const LEVEL_ROLE_GUILD_ID = '1458173373166387304';
const LEVEL_ROLE_NOTICE_CHANNEL_ID = '1458175260133298220';

// レベル→ロールID（Lv0, 5刻み。必要に応じて105以降も追加OK）
const LEVEL_ROLE_MAP = {
  0: '1458331222978728101',   // 新入りトトロ（初回XP獲得で付与・通知なし）
  5: '1458302957509411087',
  10: '1458313336427909242',
  15: '1458313861655695495',
  20: '1458314153470070906',
  25: '1458314420777123970',
  30: '1458314531393769522',
  35: '1458314668157173891',
  40: '1458314757751963791',
  45: '1458315133506814083',
  50: '1458315347600998538',
  55: '1458326817286127699',
  60: '1458326901293584464',
  65: '1458327091610255486',
  70: '1458327419793707179',
  75: '1458329148614381589',
  80: '1458329236229329001',
  85: '1458329331452608581',
  90: '1458329386037018719',
  95: '1458330201028165682',
  100: '1458330333803188363',
  // 105: 'PUT_ROLE_ID_HERE',
};

// 称号として扱うロールID一覧（付け替え時にこれらのうち “新ロール以外” を外す）
const ALL_LEVEL_ROLE_IDS = Object.values(LEVEL_ROLE_MAP).filter(Boolean);

function isLevelRoleTargetGuild(gid) {
  return !!LEVEL_ROLE_GUILD_ID && gid === LEVEL_ROLE_GUILD_ID;
}

function bracketLevelFor(lv) {
  if (lv < 5) return 0;
  return Math.floor(lv / 5) * 5;
}

function roleIdForLevel(lv) {
  const b = bracketLevelFor(lv);
  return LEVEL_ROLE_MAP[b] || null;
}

async function sendLevelRoleNotice(client, userId, newLv, newRoleId, oldRoleId) {
  if (!LEVEL_ROLE_NOTICE_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LEVEL_ROLE_NOTICE_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setTitle('🎖️ 称号が更新されました')
      .setDescription(`<@${userId}> が **Lv.${newLv}** に到達！`)
      .addFields(
        { name: '新しい称号', value: newRoleId ? `<@&${newRoleId}>` : '（未設定）', inline: true },
        { name: '前の称号', value: oldRoleId ? `<@&${oldRoleId}>` : '（なし）', inline: true },
      );

    // roles を allowedMentions に入れないことで “表示はされるが ping はしない”
    await ch.send({
      embeds: [embed],
      allowedMentions: { users: [userId], roles: [] },
    });
  } catch (e) {
    console.warn('[xp:level-role:notice]', e?.stack || e);
  }
}

async function syncLevelRole(client, gid, uid, oldTotal, newTotal, memberObj) {
  try {
    if (!isLevelRoleTargetGuild(gid)) return;
    if (!ALL_LEVEL_ROLE_IDS.length) return;

    // store.js は負のXPも作れてしまうので、ここで安全に補正
    const safeOldTotal = Math.max(0, oldTotal || 0);
    const safeNewTotal = Math.max(0, newTotal || 0);

    const oldLv = levelFromTotal(safeOldTotal);
    const newLv = levelFromTotal(safeNewTotal);

    const oldHadAnyXp = safeOldTotal > 0;
    const newHadAnyXp = safeNewTotal > 0;

    const oldBracket = bracketLevelFor(oldLv);
    const newBracket = bracketLevelFor(newLv);

    const oldRoleId = roleIdForLevel(oldLv);
    const newRoleId = roleIdForLevel(newLv);

    // 初回XP獲得（0→>0）: Lv0ロール付与（通知なし）
    const isFirstXpGain = !oldHadAnyXp && newHadAnyXp;

    // 5刻みが変わったか（付け替え通知判定）
    const isBracketChanged = oldBracket !== newBracket;

    // ロール未設定なら何もしない（安全）
    if (!newRoleId) return;

    const guild = memberObj?.guild
      ?? (client.guilds.cache.get(gid) ?? await client.guilds.fetch(gid).catch(() => null));
    if (!guild) return;

    const member = memberObj
      ?? (guild.members.cache.get(uid) ?? await guild.members.fetch(uid).catch(() => null));
    if (!member) return;

    // この管理対象の中で、今付いてる称号ロール
    const currentLevelRoles = ALL_LEVEL_ROLE_IDS.filter(rid => member.roles.cache.has(rid));

    // すでに正しい状態なら何もしない
    const alreadyCorrect =
      member.roles.cache.has(newRoleId) &&
      currentLevelRoles.every(rid => rid === newRoleId);

    if (!alreadyCorrect) {
      // newRoleId 以外の称号ロールを外す
      const removeIds = currentLevelRoles.filter(rid => rid !== newRoleId);
      if (removeIds.length) {
        await member.roles.remove(removeIds, 'XP level role swap').catch(() => {});
      }
      // newRoleId を付与
      if (!member.roles.cache.has(newRoleId)) {
        await member.roles.add(newRoleId, 'XP level role swap').catch(() => {});
      }
    }

    // 通知は “付け替えが起きた時だけ”。初回(Lv0)は通知なし。
    if (!isFirstXpGain && isBracketChanged && newBracket >= 5) {
      await sendLevelRoleNotice(client, uid, newLv, newRoleId, oldRoleId);
    }
  } catch (e) {
    console.warn('[xp:level-role]', e?.stack || e);
  }
}

// ================================
// XP付与（共通）
// ================================
async function grantXp(db, client, gid, uid, deltaXp, memberObj) {
  getOrInit(db, gid, uid);

  const before = peek(db, gid, uid);
  const oldTotal = before.total_xp || 0;

  if (deltaXp > 0) {
    addXp(db, gid, uid, deltaXp);
  } else {
    return;
  }

  const after = peek(db, gid, uid);
  const newTotal = after.total_xp || 0;

  await syncLevelRole(client, gid, uid, oldTotal, newTotal, memberObj);
}

// ---- VCセッションから付与する本体（ヘルパー） ----
// 段階レートを正しく進めるため、
// totalMs（vc_session_ms）に対する “累積ポイント” の差分で付与する
async function awardFromSession(db, client, gid, uid, memberObj, finalize = false, membersLike = null) {
  const row = peek(db, gid, uid);

  const totalMs = Math.max(0, Number(row.vc_session_ms || 0) || 0);
  const awardedMs = Math.max(0, getVcAwardedMs(db, gid, uid) || 0);

  const v = memberObj?.voice;
  const isDeaf = !!(v?.selfDeaf || v?.serverDeaf);
  const isMuted = !!(v?.selfMute || v?.serverMute);
  const mult = isDeaf ? 0 : (isMuted ? 1 : 3);

  const totalPtsNow = computeAwardPoints(0, totalMs, mult);
  const totalPtsPrev = computeAwardPoints(0, awardedMs, mult);
  const rawPoints = Math.max(0, totalPtsNow - totalPtsPrev);

  const points = applySoloVcHalfXp(rawPoints, memberObj, membersLike);

  if (points > 0) {
    await grantXp(db, client, gid, uid, points, memberObj);
  }

  // どこまで換算したかを更新（端数分は次回に回る）
  const newAwarded = Math.max(0, totalMs - remainderMs(totalMs));
  setVcAwardedMs(db, gid, uid, newAwarded);

  if (finalize) {
    takeVcSessionMs(db, gid, uid);   // vc_session_ms を0へ
    setVcAwardedMs(db, gid, uid, 0); // 換算済みmsも0へ
  }
}

// ================================
// チャンネルごとのXP倍率（現状: 50%で1XP）
// ================================
const HALF_XP_CHANNELS = {
  "993960755470794792": new Set([
    "1441307630609104958",
  ]),
};

function isHalfXpChannel(guildId, channelId) {
  const set = HALF_XP_CHANNELS[guildId];
  return !!set && set.has(channelId);
}

// ================================
// VCソロ対策用設定
// - bot は人数カウントから完全除外
// - SUB_ACCOUNT_ROLE_IDS を持つ垢は「サブ垢」として扱う
// - 半減条件: 非bot人数 < 3 かつ 本垢人数 < 2
// ================================
const SUB_ACCOUNT_ROLE_IDS = {
  "993960755470794792": new Set([
    "1210444228056981514",
  ]),
};

function isSubAccountMember(member) {
  if (!member || member.user?.bot) return false;

  const set = SUB_ACCOUNT_ROLE_IDS[member.guild?.id];
  if (!set || set.size === 0) return false;

  return [...set].some(roleId => member.roles.cache.has(roleId));
}

function normalizeVcMembers(membersLike, targetMember = null) {
  const arr = Array.isArray(membersLike)
    ? [...membersLike]
    : membersLike?.values
      ? [...membersLike.values()]
      : membersLike?.members?.values
        ? [...membersLike.members.values()]
        : [];

  // leave / move 時は target が members から既に外れてることがあるので補う
  if (targetMember && !arr.some(m => m.id === targetMember.id)) {
    arr.push(targetMember);
  }

  return arr;
}

const SOLO_VC_HALF_XP_GUILD_IDS = new Set([
  "993960755470794792",
]);

function shouldHalfSoloVcXp(targetMember, membersLike) {
  if (!targetMember || targetMember.user?.bot) return false;
  if (!SOLO_VC_HALF_XP_GUILD_IDS.has(targetMember.guild?.id)) return false;

  const humans = normalizeVcMembers(membersLike, targetMember)
    .filter(m => !m.user?.bot);

  const totalHumans = humans.length;
  const mainCount = humans.filter(m => !isSubAccountMember(m)).length;

  return totalHumans < 3 && mainCount < 2;
}

function applySoloVcHalfXp(points, targetMember, membersLike) {
  if (points <= 0) return 0;
  if (!shouldHalfSoloVcXp(targetMember, membersLike)) return points;

  // 50%の確率で今回の付与分を丸ごと通す
  return Math.random() < 0.5 ? points : 0;
}


// --- Slash command builders ---
export function buildXpCommands() {
  return [
    new SlashCommandBuilder()
      .setName('totoro_exp')
      .setDescription('累計XP/レベル（＋管理者は他人も確認可）')
      .addUserOption(o => o.setName('user').setDescription('確認したいユーザー（管理者のみ）'))
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('totoro_exp_rank')
      .setDescription('累計XPランキング上位10人')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('totoro_exp_year')
      .setDescription('当年のXPを表示')
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('totoro_exp_year_rank')
      .setDescription('当年のXPランキング上位10人')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('totoro_exp_management')
      .setDescription('特定ユーザーのXPを加減算（管理者のみ）')
      .addUserOption(o => o.setName('user').setDescription('対象ユーザー').setRequired(true))
      .addIntegerOption(o => o.setName('delta').setDescription('±n（加算/減算）').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('totoro_exp_year_management')
      .setDescription('特定ユーザーの当年XPのみを加減算（管理者のみ）')
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

      const gid = msg.guild.id;
      const uid = msg.author.id;
      const now = Date.now();

      if (getMsgCooldown(db, gid, uid) > now) return;

      getOrInit(db, gid, uid);

      let deltaXp = 1;

      if (isHalfXpChannel(gid, msg.channel.id)) {
        const willAward = Math.random() < 0.5;
        if (!willAward) deltaXp = 0;
      }

      if (deltaXp > 0) {
        void grantXp(db, client, gid, uid, deltaXp, msg.member).catch(() => {});
      }

      setMsgCooldown(db, gid, uid, now + MESSAGE_COOLDOWN_MS);

    } catch (e) {
      console.warn('[xp:msg]', e?.stack || e);
    }
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
    // join
    if (!wasIn && nowIn) {
      getOrInit(db, gid, uid);

      // 新セッション開始なので掃除（帯域を0から始める）
      takeVcSessionMs(db, gid, uid);     // vc_session_ms=0
      setVcAwardedMs(db, gid, uid, 0);   // 換算済みms=0

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
      // finalize=true で最後に掃除
      const oldMembers = oldS.channel ? [...oldS.channel.members.values()] : [];
      await awardFromSession(db, client, gid, uid, m, true, oldMembers).catch(() => {});
      return;
    }

    // move
    if (wasIn && nowIn && oldS.channelId !== newS.channelId) {
      const row = peek(db, gid, uid);
      if (row.vc_join_ts) {
        addVcSessionMs(db, gid, uid, now - row.vc_join_ts);
      }
      setVcJoin(db, gid, uid, now);
      // 移動時はセッション継続扱い（finalize=false）
      const oldMembers = oldS.channel ? [...oldS.channel.members.values()] : [];
      await awardFromSession(db, client, gid, uid, m, false, oldMembers).catch(() => {});
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

            const joined = row.vc_join_ts;
            if (joined) {
              const delta = now - joined;
              if (delta > 0) {
                addVcSessionMs(db, gid, uid, delta);
                setVcJoin(db, gid, uid, now);
              }
              await awardFromSession(db, client, gid, uid, member, false, ch.members);
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
      const total = Math.max(0, row.total_xp || 0);
      const year = Math.max(0, row.year_xp || 0);
      const lv = levelFromTotal(total);
      const toNext = xpToNextLevel(total);

      const all = getAllForRank(db, gid);
      const idx = all.findIndex(r => r.user_id === target.id);
      const rank = idx >= 0 ? idx + 1 : 0;


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
      const lines = top.map((r, idx) =>
        `${idx + 1}. <@${r.user_id}> — **${Math.max(0, r.total_xp)} XP** (Lv.${levelFromTotal(Math.max(0, r.total_xp))})`
      );
      return i.reply({ content: `🏆 **累計XPランキング**\n${lines.join('\n')}` });
    }

    if (i.commandName === 'totoro_exp_year') {
      const row = peek(db, gid, i.user.id);
      return i.reply({ content: `📅 **当年XP**：${Math.max(0, row.year_xp || 0)}` });
    }

    if (i.commandName === 'totoro_exp_year_rank') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const top = topYear(db, gid, 10);
      if (top.length === 0) return i.reply({ content: 'まだデータがないよ！', ephemeral: true });
      const lines = top.map((r, idx) =>
        `${idx + 1}. <@${r.user_id}> — **${Math.max(0, r.year_xp)} XP**`
      );
      return i.reply({ content: `🏆 **当年XPランキング**\n${lines.join('\n')}` });
    }

    if (i.commandName === 'totoro_exp_management') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const target = i.options.getUser('user', true);
      const delta = i.options.getInteger('delta', true);

      const before = peek(db, gid, target.id);
      const oldTotal = before.total_xp || 0;

      const { total_xp, year_xp } = setDeltaXp(db, gid, target.id, delta);

      // 減算でも称号が戻るので、必ず同期
      try {
        const guild = i.guild;
        const member = guild ? await guild.members.fetch(target.id).catch(() => null) : null;
        await syncLevelRole(
          client,
          gid,
          target.id,
          Math.max(0, oldTotal),
          Math.max(0, total_xp || 0),
          member
        );
      } catch {}

      return i.reply({
        content: `🛠️ <@${target.id}> に ${delta} XP を反映しました（累計:${total_xp} / 当年:${year_xp}）。`
      });
    }

    if (i.commandName === 'totoro_exp_year_management') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '管理者のみ利用できます。', ephemeral: true });
      }
      const target = i.options.getUser('user', true);
      const delta = i.options.getInteger('delta', true);

      const { total_xp, year_xp } = setDeltaYearXp(db, gid, target.id, delta);

      return i.reply({
        content: `🛠️ <@${target.id}> の **当年XP** に ${delta} XP を反映しました（累計:${total_xp} / 当年:${year_xp}）。`
      });
    }


    return false;
  }

  return { handleSlash };
}
