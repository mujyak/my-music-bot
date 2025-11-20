import { SlashCommandBuilder } from 'discord.js';
import { roll1d100 } from './index.js';

const CMD = 'totoro_1d100';

export function buildDiceSlashBuilders() {
  return [
    new SlashCommandBuilder()
      .setName(CMD)
      .setDescription('1〜100 のダイスを振る（セリフ付き）')
      .toJSON()
  ];
}

export async function handleDiceInteraction(itx) {
  if (itx.commandName !== 'totoro_1d100') return false;
  const res = await roll1d100(itx);
  return itx.reply(res);
}
