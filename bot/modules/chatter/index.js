// modules/chatter/index.js
import { normalLines, rareLines } from "./messages.js";

function parseAllowedGuilds(str) {
  if (!str) return null; // 未設定なら全許可
  return str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function pickWeighted({ normal, rare, normalWeight = 10, rareWeight = 1 }) {
  const total = normalWeight + rareWeight;
  const r = Math.random() * total;
  const bucket = r < normalWeight ? "normal" : "rare";
  const pool = bucket === "normal" ? normal : rare;
  if (!pool.length) {
    const fallback = normal.length ? normal : rare;
    return fallback[Math.floor(Math.random() * fallback.length)] || "";
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

export function wireChatterHandlers(client, opts = {}) {
  const enabled = (process.env.TOTORO_CHATTER ?? "1") !== "0";
  if (!enabled) return;

  const allowGuilds = parseAllowedGuilds(process.env.ALLOW_GUILDS);
  const cooldownSec = Number(process.env.TOTORO_CHATTER_COOLDOWN ?? "30");
  const normalWeight = Number(process.env.TOTORO_CHATTER_NORMAL_WEIGHT ?? "10");
  const rareWeight   = Number(process.env.TOTORO_CHATTER_RARE_WEIGHT ?? "1");

  const channelCooldown = new Map(); // channelId -> unix sec

  client.on("messageCreate", async (msg) => {
    try {
      // 基本ガード
      if (msg.author?.bot) return;
      if (!msg.guild) return; // DM無視
      if (allowGuilds && !allowGuilds.includes(msg.guild.id)) return;

      // @everyone/@here には反応しない
      if (msg.mentions?.everyone) return;

      const me = client.user;
      if (!me) return;

      // 本文に bot への「直接メンション」<@id> / <@!id> があるかだけで判定
      // （返信で暗黙メンションされてても本文に無ければ反応しない）
      const content = msg.content ?? "";
      const directMentionRe = new RegExp(`(^|\\s)<@!?${me.id}>(\\s|$)`);
      const hasDirectMentionInContent = directMentionRe.test(content);
      if (!hasDirectMentionInContent) return;

      // クールダウン（チャンネル単位）
      const now = Math.floor(Date.now() / 1000);
      const until = channelCooldown.get(msg.channelId) ?? 0;
      if (now < until) return;

      const line = pickWeighted({
        normal: normalLines,
        rare: rareLines,
        normalWeight,
        rareWeight
      });
      if (!line) return;

      // 返信ではなく通常メッセージを送る（矢印スレッドを出さない）
      await msg.channel.send({
        content: line,
        // 念のため、メンション自動解釈を抑制（台詞に@があっても飛ばない）
        allowedMentions: { parse: [] }
      });

      channelCooldown.set(msg.channelId, now + cooldownSec);
    } catch (err) {
      console.error("[chatter] error:", err);
    }
  });
}
