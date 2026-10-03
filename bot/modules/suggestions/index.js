// modules/suggestions/index.js
//
// トトロ目安箱機能の入口ファイル。
// ここでは Discord の interactionCreate を受け取り、
// 目安箱関連の interaction だけを interactions.js に渡す。
//
// 実際の処理内容：
// - 目安箱ボタンが押されたとき
// - モーダルが送信されたとき
// などは interactions.js 側で実装する。

import {
  isSuggestionInteraction,
  handleSuggestionInteraction,
} from './interactions.js';

/**
 * トトロ目安箱の interaction ハンドラを client に登録する。
 *
 * @param {import('discord.js').Client} client
 * @param {object} options
 */
export function wireSuggestionHandlers(client, options = {}) {
  if (!client) {
    throw new Error('[suggestions] client is required');
  }

  client.on('interactionCreate', async (interaction) => {
    try {
      // 目安箱と関係ない interaction は何もしない
      if (!isSuggestionInteraction(interaction)) return;

      await handleSuggestionInteraction(interaction, options);
    } catch (err) {
      console.error('[suggestions] interaction error:', err);

      await safeErrorReply(interaction);
    }
  });

  console.log('[suggestions] handlers wired');
}

/**
 * 既存の interactionCreate ハンドラから直接呼びたい場合用。
 *
 * 大元 index.js 側で interactionCreate を一元管理したくなった場合は、
 * wireSuggestionHandlers(client) ではなく、この関数を呼ぶ形にもできる。
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {object} options
 * @returns {Promise<boolean>} 目安箱関連なら true
 */
export async function dispatchSuggestionInteraction(interaction, options = {}) {
  if (!isSuggestionInteraction(interaction)) return false;

  await handleSuggestionInteraction(interaction, options);
  return true;
}

/**
 * エラー時に、ユーザーへ最低限の通知を返す。
 * interaction の状態に応じて reply / followUp を使い分ける。
 *
 * @param {import('discord.js').Interaction} interaction
 */
async function safeErrorReply(interaction) {
  try {
    if (!interaction || !interaction.isRepliable?.()) return;

    const payload = {
      content: '目安箱の処理中にエラーが発生しました。少し時間をおいてもう一度試してください。',
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (replyErr) {
    console.error('[suggestions] failed to send error reply:', replyErr);
  }
}