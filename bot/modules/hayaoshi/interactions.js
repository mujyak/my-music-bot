// modules/hayaoshi/interactions.js
import { MessageFlags } from 'discord.js';

const EMOJI = '🔔';
const TIMEOUT_MS = 3 * 60 * 1000;

// チャンネルごとに同時進行を防ぐ（暴発防止）
const activeByChannel = new Map(); // channelId -> timeoutId

export async function handleHayaoshiSlash(interaction) {
  const channelId = interaction.channelId;

  if (activeByChannel.has(channelId)) {
    await interaction.reply({
      content: 'いまこのチャンネルでは早押しが進行中です。終わってからもう一度どうぞ。',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // セーフティ：TIMEOUT_MS 経過で必ず解除（collectorが何らかで死んでも解除される）
  const safetyTimer = setTimeout(() => {
    activeByChannel.delete(channelId);
  }, TIMEOUT_MS + 5_000);

  activeByChannel.set(channelId, safetyTimer);

  const release = () => {
    const t = activeByChannel.get(channelId);
    if (t) clearTimeout(t);
    activeByChannel.delete(channelId);
  };

  try {
    // 早押し用メッセージ（ここにリアクションしてもらう）
    const msg = await interaction.reply({
      content:
        'トトロ早押しシステム\n' +
        '一番早くリアクションした人を判定します',
      fetchReply: true
    });

    // トトロ自身がリアクションを付ける（参加者はそれを押す）
    await msg.react(EMOJI).catch(() => null);

    const filter = (reaction, user) => {
      if (!reaction || !user || user.bot) return false;
      return reaction.emoji?.name === EMOJI;
    };

    const collector = msg.createReactionCollector({
      filter,
      max: 1,
      time: TIMEOUT_MS
    });

    collector.on('collect', async (_reaction, user) => {
      try {
        await interaction.followUp({
          content: `✅ <@${user.id}> が一番早く押しました！`
        });
      } catch {
        // 黙る
      } finally {
        collector.stop('winner');
      }
    });

    collector.on('end', async (collected, reason) => {
      // ★ここで必ず解除（winnerでもtimeoutでも解除）
      release();

      if (reason !== 'winner' && collected.size === 0) {
        try {
          await interaction.followUp({
            content: '⌛ 3分経過。誰も回答者がいませんでした。終了します。'
          });
        } catch {
          // 黙る
        }
      }
    });
  } catch (e) {
    // 途中で例外が起きた場合も解除
    release();
    throw e;
  }
}
