// modules/kojin/commands.js
import { SlashCommandBuilder } from 'discord.js';

/**
 * 返信するだけコマンド定義
 * - 追加するときはここに1項目足すだけ
 * - key が commandName（/の後の名前）になる
 */
export const KOJIN_REPLIES = {
  totoro_kobayashi: {
    description: 'うんち',
    content: 'うんちっち',
    ephemeral: false, // true にすると本人にだけ見える
  },
  // 例: 今後増やすならこんな感じ
  // totoro_foo: {
  //   description: 'foo を返します',
  //   content: 'foo!',
  //   ephemeral: true,
  // },
};

export function buildKojinCommands() {
  return Object.entries(KOJIN_REPLIES).map(([name, def]) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(def.description ?? '固定メッセージ')
  );
}
