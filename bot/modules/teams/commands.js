import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export function buildTeamCommands() {
  // /totoro_team size:<int>
  const teamCmd = new SlashCommandBuilder()
    .setName('totoro_team')
    .setDescription('リアクション参加者を n 人ずつでランダムにチーム分けします（NGペアを可能な限り回避）')
    .addIntegerOption(opt =>
      opt.setName('size')
        .setDescription('1チームの人数 (例: 3)')
        .setMinValue(1)
        .setMaxValue(25)
        .setRequired(true)
    );
  // 権限は「実行可能」に制限しない（一般ユーザーも使える想定）
  // @here を付けるかは実行時に権限で判定する
  return [teamCmd];
}
