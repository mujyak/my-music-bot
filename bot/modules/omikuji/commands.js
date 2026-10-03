// modules/omikuji/commands.js
import { SlashCommandBuilder } from 'discord.js';

export function buildOmikujiCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('totoro_omikuji')
    .setDescription('正月のおみくじを引く（ギルドごとに年1回）');

  return [cmd];
}
