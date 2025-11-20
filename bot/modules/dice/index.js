import { EmbedBuilder } from 'discord.js';
import { buildDiceSlashBuilders, handleDiceInteraction } from './commands.js';
import { loadPhrases } from './store.js';

export function buildDiceCommands() {
  return buildDiceSlashBuilders();
}

export function wireDiceHandlers(client) {
  client.on('interactionCreate', async (itx) => {
    try {
      if (!itx.isChatInputCommand()) return;
      await handleDiceInteraction(itx);
    } catch (e) {
      try {
        if (itx.isRepliable() && !itx.replied && !itx.deferred) {
          await itx.reply({ content: 'ダイス処理でエラーが起きたかも…', ephemeral: true });
        }
      } catch {}
      console.error('[dice] handler failed', e);
    }
  });
}

function bucketFromRoll(n) {
  if (n === 1) return 'crit_fail_1';
  if (n >= 2 && n <= 5) return 'near_fail_2_5';
  if (n >= 6 && n <= 20) return 'low_6_20';
  if (n >= 21 && n <= 79) return 'mid_21_79';
  if (n >= 80 && n <= 94) return 'high_80_94';
  if (n >= 95 && n <= 99) return 'near_crit_95_99';
  return 'crit_100'; // 100
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function roll1d100(itx) {
  const n = Math.floor(Math.random() * 100) + 1;
  const phrases = loadPhrases();
  const key = bucketFromRoll(n);
  const line = pick(phrases[key] || ['……']);

  const embed = new EmbedBuilder()
    .setTitle('🎲 1d100 ロール')
    .setDescription(`**結果:** \`${n}\`\n${line}`);

  // 公開メッセージとして返す
  return { embeds: [embed] };
}
