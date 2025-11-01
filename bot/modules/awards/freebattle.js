// modules/awards/freebattle.js
import { incr } from "./store.js";

// ギルドごとに「対象チャンネル」と「対象ロール」を指定
// 実運用ギルド追加時にここを埋めていく想定
let CONFIG = Object.create(null);

export function setFreebattleConfig(map) { CONFIG = map || {}; }

export function wireFreebattleMessageHook(client) {
  client.on("messageCreate", async (msg) => {
    try {
      if (!msg.guild || msg.author.bot) return;
      const cfg = CONFIG[msg.guild.id];
      if (!cfg) return; // 未設定ギルドは無視
      if (msg.channelId !== cfg.channelId) return;

      // 役職メンションを検出
      const roleId = cfg.roleId;
      const mentioned = msg.mentions?.roles?.has?.(roleId);

      if (!mentioned) return;

      const { total, year } = incr("freebattle", msg.guild.id, msg.author.id, 1);
      console.log(`[freebattle] +1 by ${msg.author.tag} in ${msg.guild.id}#${msg.channelId} total=${total} year=${year}`);
    } catch (e) {
      console.warn("[freebattle] failed:", e?.message || e);
    }
  });
}
