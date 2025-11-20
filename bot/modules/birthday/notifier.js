// modules/birthday/notifier.js
import { BIRTHDAYS, buildMessage } from "./birthdays.js";
import fs from "node:fs";
import path from "node:path";

const TZ = "Asia/Tokyo";
const JST_OFFSET = "+09:00";
const DEBUG = process.env.TOTORO_BDAY_DEBUG === "1";

/* === 時刻ユーティリティ === */
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}
function todayInJSTParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const y = Number(parts.find(p => p.type === "year").value);
  const m = Number(parts.find(p => p.type === "month").value);
  const day = Number(parts.find(p => p.type === "day").value);
  return { year: y, month: m, day };
}
function jstDateStamp(d = new Date()) {
  const { year, month, day } = todayInJSTParts(d);
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function msUntilJst(hour, minute = 0, second = 0) {
  const now = new Date();
  const { year, month, day } = todayInJSTParts(now);
  const target = new Date(`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:${String(second).padStart(2,"0")}${JST_OFFSET}`);
  const t = (now <= target) ? target : new Date(target.getTime() + 24*60*60*1000);
  return Math.max(0, t.getTime() - now.getTime());
}

/* === 永続スタンプ（当日投稿済みの記録） === */
function stampDir() {
  const p = path.resolve(process.cwd(), "data", "birthday");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
function stampPath() { return path.join(stampDir(), "last_posted.txt"); }
function readLastStamp() { try { return fs.readFileSync(stampPath(), "utf8").trim(); } catch { return ""; } }
function writeLastStamp(stamp) { try { fs.writeFileSync(stampPath(), String(stamp) || "", "utf8"); } catch {} }

/* === 今日が誕生日の名前一覧（2/29は非うるう年→2/28） === */
function resolveTodaysNames(year, month, day) {
  const leap = isLeapYear(year);
  return BIRTHDAYS.filter(({ month: m, day: d }) => {
    if (m === 2 && d === 29) {
      return (leap && month === 2 && day === 29) || (!leap && month === 2 && day === 28);
    }
    return m === month && d === day;
  }).map(b => b.name);
}

/* === 1回の投稿処理（成功/対象有無を返す） === */
async function runOnce(client, { guildId, channelId, dryRun }) {
  const stamp = jstDateStamp();
  const { year, month, day } = todayInJSTParts();
  const names = resolveTodaysNames(year, month, day);

  if (DEBUG) console.log(`[birthday][DEBUG] runOnce JST=${stamp} hits=${names.length}`);

  if (names.length === 0) {
    // 対象がいない日は “チェック済み” としてスタンプ更新（再試行不要）
    writeLastStamp(stamp);
    return { posted: false, hadTargets: false };
  }

  const message = buildMessage(month, day, names);

  if (dryRun) {
    console.log(`[birthday][DRYRUN] -> guild:${guildId} channel:${channelId}\n${message}`);
    writeLastStamp(stamp);
    return { posted: true, hadTargets: true };
  }

  // 送信可否チェック
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased?.()) {
    console.warn("[birthday] 指定チャンネルが見つからない/テキストでないため投稿できません。");
    return { posted: false, hadTargets: true };
  }
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const me = guild?.members?.me ?? (guild ? await guild.members.fetchMe().catch(() => null) : null);
  const can =
    ch.viewable &&
    ch.permissionsFor?.(me)?.has?.("ViewChannel") &&
    ch.permissionsFor?.(me)?.has?.("SendMessages");
  if (!can) {
    console.warn("[birthday] 送信権限なし（ViewChannel/SendMessages）");
    return { posted: false, hadTargets: true };
  }

  try {
    await ch.send({ content: message, allowedMentions: { parse: [] } });
    console.log(`[birthday] 投稿しました: ${month}/${day} JST`);
    writeLastStamp(stamp);
    return { posted: true, hadTargets: true };
  } catch (e) {
    console.warn("[birthday] 送信に失敗:", e?.message || e);
    return { posted: false, hadTargets: true };
  }
}

/**
 * 誕生日通知スケジューラ（0:00に一度だけ／失敗時のみ0:10に一度だけ再試行）
 */
export function scheduleBirthdayNotifier(client, {
  guildId = process.env.BIRTHDAY_GUILD_ID,
  channelId = process.env.BIRTHDAY_CHANNEL_ID,
  dryRun = process.env.TOTORO_BDAY_DRYRUN === "1",
} = {}) {
  if (!guildId || !channelId) {
    console.warn("[birthday] BIRTHDAY_GUILD_ID/BIRTHDAY_CHANNEL_ID が未設定のため無効化します。");
    return;
  }

  // 0:00のメイン実行をセット
  const scheduleForTomorrow = () => {
    const waitMid = msUntilJst(0, 0, 0);
    const waitRetry = msUntilJst(0, 10, 0);
    if (DEBUG) console.log(`[birthday][DEBUG] next 00:00 in ${Math.round(waitMid/1000)}s, retry 00:10 in ${Math.round(waitRetry/1000)}s`);

    // メイン（0:00）
    setTimeout(async () => {
      const today = jstDateStamp();
      // すでに当日スタンプ済みならスキップ（多重起動対策）
      if (readLastStamp() === today) {
        if (DEBUG) console.log("[birthday][DEBUG] already posted today (skip 00:00)");
        scheduleForTomorrow(); // 次の日のスケジュールを組み直す
        return;
      }

      const res = await runOnce(client, { guildId, channelId, dryRun });

      // 成功した or 対象がいない → そのまま翌日のスケジュール
      if (res.posted || !res.hadTargets) {
        scheduleForTomorrow();
        return;
      }

      // 失敗した（対象あり）→ 0:10 に一度だけ再試行
      const waitRetryNow = msUntilJst(0, 10, 0);
      setTimeout(async () => {
        // 再試行時点で既に投稿済みなら何もしない
        if (readLastStamp() === jstDateStamp()) {
          if (DEBUG) console.log("[birthday][DEBUG] already posted before retry (skip 00:10)");
          scheduleForTomorrow();
          return;
        }
        await runOnce(client, { guildId, channelId, dryRun });
        scheduleForTomorrow(); // 以後は翌日へ
      }, waitRetryNow);
    }, waitMid);
  };

  scheduleForTomorrow();
  console.log("[birthday] スケジューラを起動しました（JST 00:00 一回実行＋失敗時のみ 00:10 再試行）");
}

/* 手動1回実行API（テスト用に残すが常時は未使用） */
export async function runBirthdayOnceNow(client, {
  guildId = process.env.BIRTHDAY_GUILD_ID,
  channelId = process.env.BIRTHDAY_CHANNEL_ID,
  dryRun = false
} = {}) {
  return runOnce(client, { guildId, channelId, dryRun });
}
