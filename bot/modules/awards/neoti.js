// modules/awards/neoti.js
import { incr } from "./store.js";
import { AuditLogEvent, PermissionFlagsBits } from "discord.js";

/**
 * 仕様：
 * - 「権限で誰かが誰かを VC から落とした or 他 VC へ移動させた」→ 対象ユーザーの寝落ち回数+1
 * - 監査ログ (MemberDisconnect / MemberMove) を「直近数秒以内にあったかどうか」で判定
 * - Discord 側仕様で target ユーザーが取れないため、
 *   「そのタイミングで強制操作があった」ことだけを見て、
 *   voiceStateUpdate の対象ユーザーを「落とされた人」とみなす。
 */

// 過去何ミリ秒分の監査ログを見るか（※待ち時間ではない）
const LOOKBACK_MS = 3000;   // 3秒
const LOCK_MS = 5000;       // 同じ人を短時間に重複カウントしないためのロック
const SLEEP_MS = 1200;      // voiceStateUpdate から監査ログを見るまで少し待つ

// デバッグログ（詳細トレースが欲しくなったら true にする）
const DEBUG = false;

const pending = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findRecentAuditHit(guild, targetUserId) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      if (DEBUG) {
        console.log(`[neoti] skip: no ViewAuditLog permission in guild ${guild.id}`);
      }
      return null;
    }

    const logs = await guild.fetchAuditLogs({
      limit: 10,
    }).catch((e) => {
      if (DEBUG) {
        console.warn(`[neoti] fetchAuditLogs failed in guild ${guild.id}:`, e?.message || e);
      }
      return null;
    });

    if (!logs) return null;

    const now = Date.now();

    if (DEBUG) {
      console.log(`[neoti] raw audit logs (up to 10) in guild ${guild.id}:`);
      for (const e of logs.entries.values()) {
        const age = now - e.createdTimestamp;
        console.log(
          "  [entry]",
          "action=", e.action,
          " executor=", e.executor?.tag ?? e.executor?.id,
          " target=", e.target?.tag ?? e.target?.id,
          " ageMs=", age
        );
      }
    }

    // 「直近 LOOKBACK_MS 以内の MemberDisconnect / MemberMove があるか」
    const entries = [...logs.entries.values()].filter(e => {
      const age = now - e.createdTimestamp;
      const inWindow = age <= LOOKBACK_MS;
      const isType =
        e.action === AuditLogEvent.MemberDisconnect ||
        e.action === AuditLogEvent.MemberMove;
      const isSelfExec = e.executor?.id === targetUserId; // 自分が自分を操作したものは除外
      return inWindow && isType && !isSelfExec;
    });

    if (DEBUG) {
      console.log(
        `[neoti] audit hits (type-only) for ${targetUserId} in guild ${guild.id}: ${entries.length}`
      );
    }

    const hit = entries.sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!hit) return null;

    return hit;
  } catch (e) {
    if (DEBUG) {
      console.warn("[neoti] findRecentAuditHit failed:", e?.message || e);
    }
    return null;
  }
}

export function wireNeotiAuditHooks(client) {
  client.on("voiceStateUpdate", async (oldS, newS) => {
    try {
      const guild = newS?.guild ?? oldS?.guild;
      if (!guild) return;

      const targetUserId = newS.id;
      const oldId = oldS?.channelId ?? null;
      const newId = newS?.channelId ?? null;

      const leftVC = !!(oldId && !newId);
      const movedVC = !!(oldId && newId && oldId !== newId);

      // VCから抜けた or 別VCに移動したときだけ対象
      if (!leftVC && !movedVC) return;

      // Bot自身は対象外
      if (targetUserId === client.user?.id) return;

      if (DEBUG) {
        console.log(
          `[neoti] voiceStateUpdate guild=${guild.id} user=${targetUserId} old=${oldId} new=${newId} left=${leftVC} moved=${movedVC}`
        );
      }

      const key = `${guild.id}:${targetUserId}`;
      if (pending.has(key)) {
        if (DEBUG) {
          console.log(`[neoti] skip (pending) for ${key}`);
        }
        return;
      }
      pending.add(key);
      setTimeout(() => pending.delete(key), LOCK_MS);

      // 監査ログが書かれるのを少し待つ
      await sleep(SLEEP_MS);

      const hit = await findRecentAuditHit(guild, targetUserId);
      if (!hit) {
        if (DEBUG) {
          console.log(
            `[neoti] no matching audit log (type-only) for user=${targetUserId} in guild=${guild.id}`
          );
        }
        return;
      }

      const { total, year } = incr("neoti", guild.id, targetUserId, 1);
      console.log(
        `[neoti] +1 (type-only) by ${hit.executor?.tag ?? hit.executor?.id} -> target:${targetUserId} (guild:${guild.id}) total=${total} year=${year}`
      );
    } catch (e) {
      console.warn("[neoti] failed:", e?.message || e);
    }
  });
}
