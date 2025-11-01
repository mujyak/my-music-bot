// modules/awards/interactions.js
import { PermissionFlagsBits } from "discord.js";
import { peek, top, setDelta } from "./store.js";
import { CMD, embedUser } from "./commands.js";

function mustAdmin(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    i.reply({ content: "管理者のみ利用できます。", ephemeral: true });
    return false;
  }
  return true;
}

export async function handleAwardsInteraction(i) {
  const name = i.commandName;
  if (!Object.values(CMD).includes(name)) return false;

  const gid = i.guildId;

  // どのカウンタ種別かを分岐
  const isNeoti = name.startsWith("totoro_neoti");
  const kind = isNeoti ? "neoti" : "freebattle";

  if (!mustAdmin(i)) return true;

  // ----- 単体表示 -----
  if (name === CMD.NEOTI || name === CMD.FREE) {
    const user = i.options.getUser("user") ?? i.user;
    const { total, year } = peek(kind, gid, user.id);
    return i.reply({ embeds: [embedUser(isNeoti ? "寝落ち" : "フリバ募集", user.id, total, year, isNeoti ? "寝落ち回数" : "フリバ募集回数")] });
  }

  if (name === CMD.NEOTI_YEAR || name === CMD.FREE_YEAR) {
    const user = i.options.getUser("user") ?? i.user;
    const { year } = peek(kind, gid, user.id);
    return i.reply({ content: `📅 **当年** ${isNeoti ? "寝落ち" : "フリバ募集"}：${year}` });
  }

  // ----- ランキング -----
  if (name === CMD.NEOTI_RANK || name === CMD.FREE_RANK) {
    const list = top(kind, gid, 10, "total");
    if (list.length === 0) return i.reply({ content: "まだデータがないよ！", ephemeral: true });
    const lines = list.map((r, idx) => `${idx + 1}. <@${r.userId}> — **${r.total} 回**`);
    return i.reply({ content: `🏆 **${isNeoti ? "寝落ち回数" : "フリバ募集回数"}（累計）ランキング**\n${lines.join("\n")}` });
  }

  if (name === CMD.NEOTI_YEAR_RANK || name === CMD.FREE_YEAR_RANK) {
    const list = top(kind, gid, 10, "year");
    if (list.length === 0) return i.reply({ content: "まだデータがないよ！", ephemeral: true });
    const lines = list.map((r, idx) => `${idx + 1}. <@${r.userId}> — **${r.year} 回**`);
    return i.reply({ content: `🏆 **${isNeoti ? "寝落ち回数" : "フリバ募集回数"}（当年）ランキング**\n${lines.join("\n")}` });
  }

  // ----- 管理 -----
  if (name === CMD.NEOTI_MANAGE || name === CMD.FREE_MANAGE) {
    const user = i.options.getUser("user", true);
    const delta = i.options.getInteger("delta", true);
    const { total, year } = setDelta(kind, gid, user.id, delta);
    return i.reply({ content: `🛠️ <@${user.id}> に ${delta} 回を反映しました（累計:${total} / 当年:${year}）。` });
  }

  return false;
}
