// modules/roles/index.js
import fs from "node:fs";
import path from "node:path";

/**
 * data/roles/messages.json の形式:
 * {
 *   "messages": [
 *     {
 *       "guildId": "...",
 *       "channelId": "...",
 *       "messageId": "...",
 *       "initState": "pending" | "ready",   // 省略時は ready 扱い
 *       "entries": [
 *         { "emojiKey": "🔴", "roleId": "..." },
 *         { "emojiKey": "name:id", "roleId": "..." } // カスタム絵文字
 *       ]
 *     },
 *     ...
 *   ]
 * }
 */

const STORE_FILE = path.resolve(process.cwd(), "data", "roles", "messages.json");

// messageId -> { guildId, channelId, roleByEmoji, initState }
const ROLE_MESSAGES = new Map();

// reload のデバウンス
let _reloadTimer = null;

// 自分の write による fs.watch を少し無視する
let _ignoreStoreWatchUntil = 0;

// 同じ messageId の初期 catch-up 多重実行防止
const INIT_INFLIGHT = new Set();

function readStore() {
  try {
    const text = fs.readFileSync(STORE_FILE, "utf8");
    const json = JSON.parse(text);
    if (!Array.isArray(json.messages)) return { messages: [] };
    return json;
  } catch {
    return { messages: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  _ignoreStoreWatchUntil = Date.now() + 1000;
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function setMessageInitState(messageId, initState) {
  const store = readStore();
  let changed = false;

  for (const msg of store.messages) {
    if (msg.messageId !== messageId) continue;
    if (msg.initState === initState) continue;
    msg.initState = initState;
    changed = true;
  }

  if (changed) {
    writeStore(store);
  }
}

// messageId を指定して「既に押されてるリアクション」も含めてロール反映を追いつかせる
// 成功したら true、途中で主要取得に失敗したら false
async function catchUpForMessage(client, msgId) {
  const def = ROLE_MESSAGES.get(msgId);
  if (!def) return false;

  try {
    const ch = await client.channels.fetch(def.channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return false;

    const message = await ch.messages.fetch(def.messageId).catch(() => null);
    if (!message) return false;

    for (const reaction of message.reactions.cache.values()) {
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          continue;
        }
      }

      const key = emojiToKey(reaction.emoji);
      const roleId = def.roleByEmoji[key];
      if (!roleId) continue;

      const users = await reaction.users.fetch().catch(() => null);
      if (!users) continue;

      for (const user of users.values()) {
        if (user.bot) continue;

        const member = await message.guild.members.fetch(user.id).catch(() => null);
        if (!member) continue;

        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, "reaction role initial catch-up").catch(() => {});
        }
      }
    }

    return true;
  } catch (e) {
    console.warn("[roles] catchUpForMessage failed:", e?.message || e);
    return false;
  }
}

// pending の投稿だけ一度だけ catch-up する
async function processPendingMessages(client) {
  // 最新状態を読む
  loadRoleMessages();

  const pendingIds = [];
  for (const [msgId, def] of ROLE_MESSAGES.entries()) {
    if (def.initState === "pending" && !INIT_INFLIGHT.has(msgId)) {
      pendingIds.push(msgId);
    }
  }

  for (const msgId of pendingIds) {
    INIT_INFLIGHT.add(msgId);
    try {
      const ok = await catchUpForMessage(client, msgId);
      if (ok) {
        const def = ROLE_MESSAGES.get(msgId);
        if (def) def.initState = "ready";
        setMessageInitState(msgId, "ready");
        console.log(`[roles] initial catch-up completed: message=${msgId}`);
      } else {
        console.warn(`[roles] initial catch-up postponed: message=${msgId}`);
      }
    } finally {
      INIT_INFLIGHT.delete(msgId);
    }
  }
}

// messages.json を再読み込みし、pending のものだけ catch-up する
async function reloadRoleMessagesAndCatchUp(client) {
  loadRoleMessages();
  await processPendingMessages(client);
}

// messages.json の変更を監視して自動 reload（デバウンスつき）
function watchRoleStore(client) {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ messages: [] }, null, 2), "utf8");
  }

  fs.watch(dir, (eventType, filename) => {
    if (Date.now() < _ignoreStoreWatchUntil) return;
    if (filename && filename !== path.basename(STORE_FILE)) return;

    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
      reloadRoleMessagesAndCatchUp(client).catch((e) => {
        console.warn("[roles] reloadRoleMessagesAndCatchUp failed:", e?.message || e);
      });
    }, 300);
  });

  console.log("[roles] watching role-message store:", STORE_FILE);
}

// 起動時に JSON を読み込む
function loadRoleMessages() {
  ROLE_MESSAGES.clear();

  const json = readStore();
  const list = Array.isArray(json.messages) ? json.messages : [];

  for (const msg of list) {
    if (!msg.messageId || !msg.guildId || !Array.isArray(msg.entries)) continue;

    const roleByEmoji = Object.create(null);
    for (const ent of msg.entries) {
      if (!ent.emojiKey || !ent.roleId) continue;
      roleByEmoji[ent.emojiKey] = ent.roleId;
    }

    ROLE_MESSAGES.set(msg.messageId, {
      guildId: msg.guildId,
      channelId: msg.channelId,
      roleByEmoji,
      // 既存の古い投稿は再走査したくないので、未指定は ready 扱い
      initState: msg.initState === "pending" ? "pending" : "ready",
    });
  }

  console.log(`[roles] loaded ${ROLE_MESSAGES.size} role-message definitions`);
}

// reaction の emoji から key を作る（スクリプト側と同じルール）
// - 通常絵文字: emoji.name
// - カスタム: "name:id"
function emojiToKey(emoji) {
  if (emoji.id) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name;
}

// メンバーにロールを付与/剥奪する共通処理
async function applyRoleChange(reaction, user, add) {
  try {
    if (user.bot) return;
    const message = reaction.message;

    const msgId = message.id;
    const def = ROLE_MESSAGES.get(msgId);
    if (!def) return; // ロール付与対象メッセージではない

    const key = emojiToKey(reaction.emoji);
    const roleId = def.roleByEmoji[key];
    if (!roleId) return; // 対応するロールがない絵文字

    const guild = message.guild;
    if (!guild) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (add) {
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, "reaction role add").catch(() => {});
        console.log(`[roles] add role ${roleId} to ${member.user.tag} via emoji=${key}`);
      }
    } else {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, "reaction role remove").catch(() => {});
        console.log(`[roles] remove role ${roleId} from ${member.user.tag} via emoji=${key}`);
      }
    }
  } catch (e) {
    console.warn("[roles] applyRoleChange failed:", e?.message || e);
  }
}

// 公開 API：大元 index.js から呼ぶ
export function wireRoleHandlers(client) {
  loadRoleMessages();
  watchRoleStore(client);

  const runInitialPendingCatchUp = () => {
    processPendingMessages(client).catch((e) => {
      console.warn("[roles] initial pending catch-up failed:", e?.message || e);
    });
  };

  // ログイン完了後に、pending のものだけ初回 catch-up
  if (typeof client.isReady === "function" && client.isReady()) {
    setTimeout(runInitialPendingCatchUp, 1000);
  } else {
    client.once("clientReady", () => {
      setTimeout(runInitialPendingCatchUp, 1000);
    });
  }

  // リアクション追加
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }
      await applyRoleChange(reaction, user, true);
    } catch {}
  });

  // リアクション削除
  client.on("messageReactionRemove", async (reaction, user) => {
    try {
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }
      await applyRoleChange(reaction, user, false);
    } catch {}
  });
}

//cd /home/ubuntu/my-music-bot
//sudo docker compose exec bot_totoro node scripts/post-roles-message.js 1458176617099563029 data/roles/kintore.json