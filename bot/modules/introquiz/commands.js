import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export function buildIntroCommands() {
  return [
    new SlashCommandBuilder()
      .setName('totoro_intro')
      .setDescription('イントロクイズを開始します')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addIntegerOption(option =>
        option
          .setName('n')
          .setDescription('問題番号')
          .setRequired(true)
          .setMinValue(1)
      ),
  ];
}