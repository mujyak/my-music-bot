// modules/awards/commands.js
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { peek, top, setDelta } from "./store.js";

const CMD = {
  NEOTI: "totoro_neoti",
  NEOTI_YEAR: "totoro_neoti_year",
  NEOTI_RANK: "totoro_neoti_rank",
  NEOTI_YEAR_RANK: "totoro_neoti_year_rank",
  NEOTI_MANAGE: "totoro_neoti_manage",

  FREE: "totoro_freebattle",
  FREE_YEAR: "totoro_freebattle_year",
  FREE_RANK: "totoro_freebattle_rank",
  FREE_YEAR_RANK: "totoro_freebattle_year_rank",
  FREE_MANAGE: "totoro_freebattle_manage",
};

export function buildNeotiCommands() {
  const admin = PermissionFlagsBits.ManageGuild; // 全て管理者限定 & 非管理者には表示されにくい

  return [
    new SlashCommandBuilder()
      .setName(CMD.NEOTI)
      .setDescription("寝落ち回数（累計/当年）を表示（指定なければ自分）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー"))
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.NEOTI_YEAR)
      .setDescription("寝落ち回数（当年）を表示（指定なければ自分）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー"))
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.NEOTI_RANK)
      .setDescription("寝落ち回数（累計）ランキング上位10人")
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.NEOTI_YEAR_RANK)
      .setDescription("寝落ち回数（当年）ランキング上位10人")
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.NEOTI_MANAGE)
      .setDescription("寝落ち回数を加減算（管理者のみ）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー").setRequired(true))
      .addIntegerOption(o => o.setName("delta").setDescription("±n（加算/減算）").setRequired(true))
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
  ];
}

export function buildFreebattleCommands() {
  const admin = PermissionFlagsBits.ManageGuild;

  return [
    new SlashCommandBuilder()
      .setName(CMD.FREE)
      .setDescription("フリバ募集回数（累計/当年）を表示（指定なければ自分）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー"))
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.FREE_YEAR)
      .setDescription("フリバ募集回数（当年）を表示（指定なければ自分）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー"))
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.FREE_RANK)
      .setDescription("フリバ募集回数（累計）ランキング上位10人")
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.FREE_YEAR_RANK)
      .setDescription("フリバ募集回数（当年）ランキング上位10人")
      .setDefaultMemberPermissions(admin)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.FREE_MANAGE)
      .setDescription("フリバ募集回数を加減算（管理者のみ）")
      .addUserOption(o => o.setName("user").setDescription("対象ユーザー").setRequired(true))
      .addIntegerOption(o => o.setName("delta").setDescription("±n（加算/減算）").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON(),
  ];
}

export { CMD };

// 小さな共通表示
export function embedUser(name, uId, total, year, title) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`<@${uId}>`)
    .addFields(
      { name: "累計", value: String(total), inline: true },
      { name: "当年", value: String(year), inline: true },
    );
}
