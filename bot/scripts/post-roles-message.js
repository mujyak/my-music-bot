#!/usr/bin/env node
import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";

// data/roles/messages.json に保存する
const STORE_FILE = path.resolve(process.cwd(), "data", "roles", "messages.json");

const PROFILE_PREFIX = {
  totoro: "TOTORO_",
  nakatoro: "NAKATORO_",
  kototoro: "KOTORO_",
};

const ALL_PREFIXES = ["TOTORO_", "NAKATORO_", "KOTORO_"];

// 環境変数を柔軟に解決する
function resolveEnv(baseName) {
  if (process.env[baseName]) {
    return {
      value: process.env[baseName],
      source: baseName,
    };
  }

  const profile = String(process.env.BOT_PROFILE || "").trim().toLowerCase();
  const prefix = PROFILE_PREFIX[profile];
  if (prefix) {
    const profiled = process.env[`${prefix}${baseName}`];
    if (profiled) {
      return {
        value: profiled,
        source: `${prefix}${baseName}`,
      };
    }
  }

  for (const p of ALL_PREFIXES) {
    const v = process.env[`${p}${baseName}`];
    if (v) {
      return {
        value: v,
        source: `${p}${baseName}`,
      };
    }
  }

  return {
    value: undefined,
    source: undefined,
  };
}

// 設定ファイルの読み込み
function loadConfig(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  const text = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(text);

  if (!json.content || !Array.isArray(json.entries)) {
    throw new Error("config の形式が不正です。content と entries が必要です。");
  }
  return json;
}

// messages.json の読み書き
function loadStore() {
  try {
    const text = fs.readFileSync(STORE_FILE, "utf8");
    const json = JSON.parse(text);
    if (!Array.isArray(json.messages)) return { messages: [] };
    return json;
  } catch {
    return { messages: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

// emoji表記を「キー」に正規化する
// - 通常絵文字: そのまま (例: "🔴")
// - カスタム絵文字: "<:name:id>" → "name:id"
function normalizeEmojiString(str) {
  const m = str.match(/^<a?:([^:>]+):(\d+)>$/);
  if (m) {
    const name = m[1];
    const id = m[2];
    return `${name}:${id}`;
  }
  return str;
}

// メイン処理
async function main() {
  const tokenInfo = resolveEnv("DISCORD_TOKEN");
  const token = tokenInfo.value;

  if (!token) {
    console.error("DISCORD_TOKEN 系の環境変数が見つかりません。");
    console.error("確認候補: DISCORD_TOKEN / TOTORO_DISCORD_TOKEN / NAKATORO_DISCORD_TOKEN / KOTORO_DISCORD_TOKEN");
    process.exit(1);
  }

  const [,, channelId, configPath] = process.argv;
  if (!channelId || !configPath) {
    console.error("使い方: node scripts/post-roles-message.js <channelId> <configPath>");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  const rest = new REST({ version: "10" }).setToken(token);

  console.log(
    `using token source: ${tokenInfo.source}` +
    (process.env.BOT_PROFILE ? ` (BOT_PROFILE=${process.env.BOT_PROFILE})` : "")
  );

  // チャンネル情報を取得して guildId を知る
  const channel = await rest.get(Routes.channel(channelId));
  const guildId = channel.guild_id;
  if (!guildId) {
    console.error("指定されたチャンネルはギルドチャンネルではありません。");
    process.exit(1);
  }

  // メッセージを送信
  const message = await rest.post(
    Routes.channelMessages(channelId),
    { body: { content: config.content } }
  );

  console.log(`posted role message: guild=${guildId} channel=${channelId} message=${message.id}`);

  // Bot 自身でリアクションを付ける
  for (const entry of config.entries) {
    const rawEmoji = entry.emoji;
    const key = normalizeEmojiString(rawEmoji);

    let emojiForApi = rawEmoji;
    const m = rawEmoji.match(/^<a?:([^:>]+):(\d+)>$/);
    if (m) {
      const name = m[1];
      const id = m[2];
      emojiForApi = `${name}:${id}`;
    }

    const encoded = encodeURIComponent(emojiForApi);

    try {
      await rest.put(
        Routes.channelMessageOwnReaction(channelId, message.id, encoded),
        { body: {} }
      );
      console.log(`  added reaction: ${rawEmoji} (key=${key})`);
    } catch (e) {
      console.warn(`  failed to add reaction ${rawEmoji}:`, e?.message || e);
    }
  }

  // messages.json に登録
  const store = loadStore();
  store.messages.push({
    guildId,
    channelId,
    messageId: message.id,
    initState: "pending",
    entries: config.entries.map(e => ({
      emojiKey: normalizeEmojiString(e.emoji),
      roleId: e.roleId
    }))
  });
  saveStore(store);

  console.log("settings saved to:", STORE_FILE);
  console.log("initState=pending で登録しました。bot 側が初回 catch-up 後に ready へ更新します。");
}

// 実行
main().catch(err => {
  console.error("failed:", err);
  process.exit(1);
});