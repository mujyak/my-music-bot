import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import { getIntroQuestion } from './questions.js';
import { getIntroSession, setIntroSession, clearIntroSession, isIntroActive } from './state.js';

import { ensureConnectionV4 } from '../music/lavalink.js';
import { buildIdentifier, toArray } from '../music/utils.js';
import { getState, cancelIdle } from '../music/state.js';
import { runWithGuildLock } from '../music/locks.js';
import { leaveHardAndClear } from '../music/service.js';

const EMOJI = '🔔';
const START_DELAY_MS = 3000;
const LEAVE_DELAY_MS = 3000;
const SELF_LEAVE_GRACE_MS = 10_000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMusicBusy(guildId) {
  const st = getState(guildId);
  return !!(
    st?.introActive ||
    st?.playing ||
    st?.current ||
    (Array.isArray(st?.queue) && st.queue.length > 0) ||
    st?.idleTimer ||
    st?.conn
  );
}

async function resolveSingleTrack(player, url) {
  const result = await player.node.rest.resolve(buildIdentifier(url));
  const tracks = toArray(result?.data ?? result?.tracks ?? []);
  const first = tracks[0];
  if (!first) return null;

  const encoded = first.encoded ?? first.track ?? null;
  if (!encoded) return null;

  return { track: first, encoded };
}

async function safeStop(player) {
  try {
    if (typeof player.stopTrack === 'function') {
      await player.stopTrack();
      return;
    }
  } catch {}

  try {
    if (typeof player.stop === 'function') {
      await player.stop();
      return;
    }
  } catch {}
}

async function cleanupAndLeave(guildId, session, { stopPlayback = true, waitBeforeLeave = true } = {}) {
  if (!session || session.ended) return;
  session.ended = true;

  if (session.startTimer) {
    clearTimeout(session.startTimer);
    session.startTimer = null;
  }

  if (session.leaveTimer) {
    clearTimeout(session.leaveTimer);
    session.leaveTimer = null;
  }

  if (session.collector && !session.collector.ended) {
    try {
      session.collector.stop('cleanup');
    } catch {}
  }

  if (stopPlayback) {
    session.stopRequested = true;
    await safeStop(session.player);
  }

  if (waitBeforeLeave) {
    await wait(LEAVE_DELAY_MS);
  }

  const st = getState(guildId);
  st.selfLeaveUntil = Date.now() + SELF_LEAVE_GRACE_MS;

  await leaveHardAndClear(guildId);
  clearIntroSession(guildId);
}

export async function handleIntroSlash(interaction) {
  if (!interaction.inGuild()) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'このコマンドはサーバー管理権限を持つ人だけが使えます。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const no = interaction.options.getInteger('n', true);
  const question = getIntroQuestion(no);

  if (!question?.url) {
    await interaction.reply({
      content: `問題 ${no} はまだ登録されていないよ。data/intro/questions.json に追加してね。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: 'まずはあなたがVCに入ってから実行してね。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await runWithGuildLock(guildId, async () => {
    if (isIntroActive(guildId) || isMusicBusy(guildId)) {
      await interaction.reply({
        content: 'いまこのサーバーでは音楽再生中、またはイントロクイズ進行中です。終わってから使ってね。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    let player = null;
    try {
      player = await ensureConnectionV4(guildId, voiceChannel.id);
    } catch (err) {
      console.error('[introquiz] VC接続失敗:', err);
    }

    if (!player) {
      await interaction.editReply('VCへの接続に失敗しました。');
      return;
    }

    let resolved = null;
    try {
      resolved = await resolveSingleTrack(player, question.url);
    } catch (err) {
      console.error('[introquiz] トラック解決失敗:', err);
    }

    if (!resolved) {
      await interaction.editReply(`問題 ${no} のURLを再生できませんでした。URLを確認してね。`);
      const st = getState(guildId);
      st.selfLeaveUntil = Date.now() + SELF_LEAVE_GRACE_MS;
      await leaveHardAndClear(guildId);
      clearIntroSession(guildId);
      return;
    }

    const st = getState(guildId);
    cancelIdle(guildId);
    st.introActive = true;

    const session = {
      guildId,
      no,
      player,
      ended: false,
      stopRequested: false,
      startTimer: null,
      collector: null,
      answerOrder: [],        // 回答順の user.id 配列
      answerWindowCloseAt: 0, // 最初の押下から3秒後まで受付
      leaveTimer: null,       // 退室用タイマー
      firstBuzzSent: false,   // 一番乗り案内を二重送信しない
    };
    setIntroSession(guildId, session);

    const title = typeof question.title === 'string' ? question.title.trim() : '';

    await interaction.editReply(
      [
        `イントロクイズ🎵 【 ${title || 'タイトル未設定'} 】`,
        '3秒後に再生開始します',
      ].join('\n')
    );

    const replyMessage = await interaction.fetchReply().catch(() => null);
    if (!replyMessage) {
      await cleanupAndLeave(guildId, session);
      return;
    }

    await replyMessage.react(EMOJI).catch(() => {});

    const collector = replyMessage.createReactionCollector({
      filter: (reaction, user) => {
        if (reaction.emoji.name !== EMOJI) return false;
        if (user.bot) return false;

        const cur = getIntroSession(guildId);
        if (!cur || cur !== session || cur.ended) return false;

        // 最初の押下前なら即受付
        if (!cur.answerWindowCloseAt) return true;

        // 最初の押下後は、退室までの3秒間だけ受付
        return Date.now() <= cur.answerWindowCloseAt;
      },
      time: 60 * 60 * 1000,
    });

    session.collector = collector;

    collector.on('collect', async (_reaction, user) => {
      const cur = getIntroSession(guildId);
      if (!cur || cur !== session || cur.ended) return;

      // 同じ人を二重登録しない
      if (!cur.answerOrder.includes(user.id)) {
        cur.answerOrder.push(user.id);
      }

      // 2人目以降なら順番記録だけして終了
      if (cur.answerWindowCloseAt) return;

      // ここから「最初の1人」のときだけ実行
      cur.stopRequested = true;
      cur.answerWindowCloseAt = Date.now() + LEAVE_DELAY_MS;

      if (cur.startTimer) {
        clearTimeout(cur.startTimer);
        cur.startTimer = null;
      }

      await safeStop(cur.player);

      if (!cur.firstBuzzSent) {
        cur.firstBuzzSent = true;
        await interaction.channel?.send({
          content: `🛎️ <@${user.id}> さんが一番乗り！ \n他の回答者も3秒間だけ受け付けます。`,
        }).catch(() => {});
      }

      cur.leaveTimer = setTimeout(async () => {
        const latest = getIntroSession(guildId);
        if (!latest || latest !== session || latest.ended) return;

        const orderText = latest.answerOrder.length > 0
          ? latest.answerOrder
              .map((uid, idx) => `${idx + 1}. <@${uid}>`)
              .join('\n')
          : '（回答者なし）';

        await interaction.channel?.send({
          content:
            `📋 回答順はこちら！\n${orderText}\n`,
        }).catch(() => {});

        await cleanupAndLeave(guildId, latest, {
          stopPlayback: false,
          waitBeforeLeave: false,
        });
      }, LEAVE_DELAY_MS);

      cur.leaveTimer.unref?.();
    });

    session.startTimer = setTimeout(async () => {
      const cur = getIntroSession(guildId);
      if (!cur || cur !== session || cur.ended || cur.stopRequested || cur.answerWindowCloseAt) return;

      if (typeof cur.player.once === 'function') {
        cur.player.once('end', async () => {
          const latest = getIntroSession(guildId);
          if (!latest || latest !== session || latest.ended || latest.stopRequested) return;

          await interaction.followUp({
            content: `⏹️ 問題${no} の再生が終わりました。今回は回答者なしで終了します。\n3秒後にトトロは退室します。`,
          }).catch(() => {});

          await cleanupAndLeave(guildId, latest, { stopPlayback: false });
        });
      }

      try {
        await cur.player.playTrack({ track: { encoded: resolved.encoded } });
      } catch (err) {
        console.error('[introquiz] 再生開始失敗:', err);

        await interaction.followUp({
          content: `⚠️ 問題${no} の再生開始に失敗しました。3秒後にトトロは退室します。`,
        }).catch(() => {});

        await cleanupAndLeave(guildId, cur, { stopPlayback: false });
      }
    }, START_DELAY_MS);

    session.startTimer.unref?.();
  });
}

export async function dispatchIntroInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'totoro_intro') return false;

  await handleIntroSlash(interaction);
  return true;
}