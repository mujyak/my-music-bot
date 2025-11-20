// modules/awards/freebattle.js
import { incr } from "./store.js";

// ギルドごとに「対象チャンネル」と「対象ロール群」を指定
// 実運用ギルド追加時に index.js 側から setFreebattleConfig(...) で渡される想定
//
// CONFIG の中身の実体は：
// {
//   [guildId]: {
//     channelId: "テキストチャンネルID",
//     roleIds: ["ロールID1", "ロールID2", ...]  // 1個でも複数でもOK
//   },
//   ...
// }
let CONFIG = Object.create(null);

// 外部から渡される設定は
//   { guildId: { channelId, roleId } }
// または
//   { guildId: { channelId, roleIds: [...] } }
// のどちらでも受け取り、内部では roleIds 配列に正規化する
export function setFreebattleConfig(map) {
  const normalized = Object.create(null);

  for (const [gid, cfg] of Object.entries(map || {})) {
    if (!cfg || !cfg.channelId) continue;

    const channelId = String(cfg.channelId);

    let roleIds = [];
    if (Array.isArray(cfg.roleIds)) {
      roleIds = cfg.roleIds
        .filter(Boolean)
        .map(String);
    } else if (cfg.roleId) {
      // 後方互換: 旧来の roleId 1個指定も許容
      roleIds = [String(cfg.roleId)];
    }

    if (!roleIds.length) continue;

    normalized[String(gid)] = { channelId, roleIds };
  }

  CONFIG = normalized;
}

export function wireFreebattleMessageHook(client) {
  client.on("messageCreate", async (msg) => {
    try {
      if (!msg.guild || msg.author.bot) return;

      const cfg = CONFIG[msg.guild.id];
      if (!cfg) return; // このギルドは対象外

      // 対象チャンネルかチェック
      if (msg.channelId !== cfg.channelId) return;

      // 役職メンションを検出
      const mentionedRoles = msg.mentions?.roles;
      if (!mentionedRoles || mentionedRoles.size === 0) return;

      // 設定されている roleIds のどれか 1つでもメンションされていればヒット
      const hit = cfg.roleIds.some((rid) => mentionedRoles.has(rid));
      if (!hit) return;

      const { total, year } = incr("freebattle", msg.guild.id, msg.author.id, 1);
      console.log(
        `[freebattle] +1 by ${msg.author.tag} in ${msg.guild.id}#${msg.channelId} total=${total} year=${year}`
      );
    } catch (e) {
      console.warn("[freebattle] failed:", e?.message || e);
    }
  });
}
