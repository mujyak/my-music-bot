// modules/awards/neoti.js
import { incr } from "./store.js";
import { AuditLogEvent, PermissionFlagsBits } from "discord.js";

/**
 * 仕様：
 * - 「権限で誰かが誰かを VC から落とした or 他 VC へ移動させた」→ 対象ユーザーの寝落ち回数+1
 * - 監査ログ (MemberDisconnect / MemberMove) を直近数秒で照合し、executor != target で判定
 * - すべてのギルドで有効
 */

const LOOKBACK_MS = 8000; // 8秒以内の監査ログを対象に
const pending = new Set(); // 同一ユーザーの短時間重複カウントを避ける簡易ロック

async function findRecentAuditHit(guild, targetUserId) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

    const logs = await guild.fetchAuditLogs({
      limit: 10,
      // 種類はまとめて取って後段で絞る（実装差異に強い）
    }).catch(() => null);

    if (!logs) return null;
    const now = Date.now();
    // 対象種類だけを抽出
    const entries = [...logs.entries.values()].filter(e => {
      return (
        (e.action === AuditLogEvent.MemberDisconnect || e.action === AuditLogEvent.MemberMove) &&
        e.target?.id === targetUserId &&
        (now - e.createdTimestamp) <= LOOKBACK_MS
      );
    });
    // 一番新しいものを採用
    const hit = entries.sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!hit) return null;
    if (!hit.executor || hit.executor.id === targetUserId) return null; // 自分で抜けた/移動したのは対象外
    return hit;
  } catch {
    return null;
  }
}

// voiceStateUpdate で「メンバーがVCから消えた／別VCへ移動した」を検知して監査ログと突合
export function wireNeotiAuditHooks(client) {
  client.on("voiceStateUpdate", async (oldS, newS) => {
    try {
      const guild = newS?.guild ?? oldS?.guild;
      if (!guild) return;

      const targetUserId = newS.id; // 変化したユーザー
      const leftVC = !!(oldS?.channelId && !newS?.channelId);
      const movedVC = !!(oldS?.channelId && newS?.channelId && oldS.channelId !== newS.channelId);

      if (!leftVC && !movedVC) return;

      // Bot自身は対象外
      if (targetUserId === client.user?.id) return;

      // 過剰カウント抑制
      const key = `${guild.id}:${targetUserId}`;
      if (pending.has(key)) return;
      pending.add(key);
      setTimeout(() => pending.delete(key), 3000);

      // 監査ログ上の「他者による切断/移動」を確認
      const hit = await findRecentAuditHit(guild, targetUserId);
      if (!hit) return;

      // カウントアップ（累計/年）
      const { total, year } = incr("neoti", guild.id, targetUserId, 1);
      console.log(`[neoti] +1 by ${hit.executor?.tag ?? hit.executor?.id} -> target:${targetUserId} (guild:${guild.id}) total=${total} year=${year}`);
    } catch (e) {
      console.warn("[neoti] failed:", e?.message || e);
    }
  });
}
