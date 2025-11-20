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

// messageId -> { guildId, channelId, roleByEmoji }
const ROLE_MESSAGES = new Map();

// 起動時に JSON を読み込む
function loadRoleMessages() {
  ROLE_MESSAGES.clear();

  let json;
  try {
    const text = fs.readFileSync(STORE_FILE, "utf8");
    json = JSON.parse(text);
  } catch {
    json = { messages: [] };
  }

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
      roleByEmoji
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
  // 起動時に一度だけ JSON を読み込む
  loadRoleMessages();

  // 必要があれば、将来「リロード」機能も足せる

  // リアクション追加
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      // partial 対応
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
