// modules/chatter/index.js
import { normalLines as _normal, rareLines as _rare, ultraLines as _ultra } from "./messages.js";

function parseAllowedGuilds(str) {
  if (!str) return null;
  return str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// 3層（normal/rare/ultra）の “各アイテム重み” 抽選
function pickWeighted({ normal, rare, ultra, wn = 100, wr = 10, wu = 1 }) {
  const n = Array.isArray(normal) ? normal : [];
  const r = Array.isArray(rare)   ? rare   : [];
  const u = Array.isArray(ultra)  ? ultra  : [];

  const nWeight = wn * n.length;
  const rWeight = wr * r.length;
  const uWeight = wu * u.length;

  const total = nWeight + rWeight + uWeight;
  if (total <= 0) return "";

  let x = Math.random() * total;

  if (x < nWeight) {
    const idx = Math.floor(x / wn);        // 各通常セリフの幅＝wn
    return n[idx];
  }
  x -= nWeight;

  if (x < rWeight) {
    const idx = Math.floor(x / wr);        // 各レアセリフの幅＝wr
    return r[idx];
  }
  x -= rWeight;

  const idx = Math.floor(x / wu);          // 各超レアセリフの幅＝wu
  return u[idx];
}


export function wireChatterHandlers(client) {
  const enabled = (process.env.TOTORO_CHATTER ?? "1") !== "0";
  if (!enabled) return;

  const allowGuilds = parseAllowedGuilds(process.env.ALLOW_GUILDS);
  const cooldownSec = Number(process.env.TOTORO_CHATTER_COOLDOWN ?? "30");

  // 既定: 100:10:1 ＝ 普通:レア=1/10, レア:超=1/10
  const normalWeight = Number(process.env.TOTORO_CHATTER_NORMAL_WEIGHT ?? "100");
  const rareWeight   = Number(process.env.TOTORO_CHATTER_RARE_WEIGHT   ?? "10");
  const ultraWeight  = Number(process.env.TOTORO_CHATTER_ULTRA_WEIGHT  ?? "1");

  // 台詞プール（messages.js 未定義でも空配列に）
  const normal = Array.isArray(_normal) ? _normal : [];
  const rare   = Array.isArray(_rare)   ? _rare   : [];
  const ultra  = Array.isArray(_ultra)  ? _ultra  : [];

  const channelCooldown = new Map(); // channelId -> unix sec

  client.on("messageCreate", async (msg) => {
    try {
      // 基本ガード
      if (msg.author?.bot) return;
      if (!msg.guild) return;
      if (allowGuilds && !allowGuilds.includes(msg.guild.id)) return;
      if (msg.mentions?.everyone) return; // @everyone/@here 無視

      const me = client.user;
      if (!me) return;

      // 本文に <@id> / <@!id> の“直接メンション”が含まれるときのみ反応（返信は無視）
      const content = msg.content ?? "";
      const directMentionRe = new RegExp(`(^|\\s)<@!?${me.id}>(\\s|$)`);
      const hasDirectMentionInContent = directMentionRe.test(content);
      if (!hasDirectMentionInContent) return;

      // チャンネル単位クールダウン
      const now = Math.floor(Date.now() / 1000);
      const until = channelCooldown.get(msg.channelId) ?? 0;
      if (now < until) return;

      const line = pickWeighted({
        normal, rare, ultra,
        wn: normalWeight, wr: rareWeight, wu: ultraWeight,
      });
      if (!line) return;

      // 返信UIを出さずに通常メッセージで発言
      await msg.channel.send({
        content: line,
        allowedMentions: { parse: [] } // 台詞中の @ を無効化
      });

      channelCooldown.set(msg.channelId, now + cooldownSec);
    } catch (err) {
      console.error("[chatter] error:", err);
    }
  });
}
