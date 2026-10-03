// modules/hayaoshi/commands.js
import { SlashCommandBuilder } from 'discord.js';

export function buildHayaoshiCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('totoro_hayaoshi')
    .setDescription('早押し（リアクション最速）を開始します');

  return [cmd];
}
