// modules/birthday/notifier.js
import { BIRTHDAYS, buildMessage } from "./birthdays.js";

const TZ = "Asia/Tokyo";
const JST_OFFSET = "+09:00";

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

function msUntilNextJstMidnight() {
  const now = new Date();
  const { year, month, day } = todayInJSTParts(now);
  const today00 = new Date(`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T00:00:00${JST_OFFSET}`);
  let next = today00;
  if (now >= next) next = new Date(today00.getTime() + 24*60*60*1000);
  return next.getTime() - now.getTime();
}

function resolveTodaysNames(year, month, day) {
  const leap = isLeapYear(year);
  return BIRTHDAYS.filter(({ month: m, day: d }) => {
    if (m === 2 && d === 29) {
      return (leap && month === 2 && day === 29) || (!leap && month === 2 && day === 28);
    }
    return m === month && d === day;
  }).map(b => b.name);
}

/**
 * 誕生日通知スケジューラ
 * - 1ギルド1チャンネル向け。0:00(JST)にメッセージ投稿（メンション無し）
 * - 複数インスタンス前提ではありません（単一コンテナで運用）
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

  const tick = async () => {
    try {
      const { year, month, day } = todayInJSTParts();
      const names = resolveTodaysNames(year, month, day);

      if (names.length === 0) {
        if (dryRun) console.log(`[birthday] ${month}/${day} JST: 該当者なし`);
      } else {
        const message = buildMessage(month, day, names);

        if (dryRun) {
          console.log(`[birthday][DRYRUN] -> guild:${guildId} channel:${channelId}\n${message}`);
        } else {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel?.isTextBased?.()) {
            console.warn("[birthday] 指定チャンネルが見つからない/テキストでないため投稿できません。");
          } else {
            await channel.send({ content: message });
            console.log(`[birthday] 投稿しました: ${month}/${day} JST`);
          }
        }
      }
    } catch (err) {
      console.error("[birthday] 投稿中にエラー:", err);
    } finally {
      setTimeout(tick, msUntilNextJstMidnight());
    }
  };

  // 初回実行を「次のJST 00:00」に合わせる
  setTimeout(tick, msUntilNextJstMidnight());
  console.log("[birthday] スケジューラを起動しました（JST 00:00 に実行）");
}
