// modules/suggestions/store.js
//
// トトロ目安箱の投稿データ保存用。
// SQLite に投稿内容・投稿者・運営通知メッセージIDなどを保存する。
//
// DB保存先:
// data/suggestions/suggestions.sqlite

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  'data',
  'suggestions',
  'suggestions.sqlite',
);

let db = null;
let openedDbPath = null;

/**
 * 目安箱DBを開く。
 *
 * @param {object} options
 * @param {string} [options.dbPath]
 * @returns {Database.Database}
 */
export function openSuggestionDb(options = {}) {
  const dbPath =
    options.dbPath ||
    process.env.SUGGESTIONS_DB_PATH ||
    DEFAULT_DB_PATH;

  if (db && openedDbPath === dbPath) {
    return db;
  }

  ensureParentDir(dbPath);

  db = new Database(dbPath);
  openedDbPath = dbPath;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  return db;
}

/**
 * 投稿を1件保存する。
 *
 * @param {object} input
 * @param {string} input.guildId
 * @param {string} input.userId
 * @param {string} input.username
 * @param {string} [input.displayName]
 * @param {string} input.title
 * @param {string} input.content
 * @param {string} input.staffChannelId
 * @param {object} [options]
 * @returns {object} 保存された投稿データ
 */
export function createSuggestion(input, options = {}) {
  const database = openSuggestionDb(options);

  const now = new Date().toISOString();

  const data = {
    guildId: requireNonEmptyString(input.guildId, 'guildId'),
    userId: requireNonEmptyString(input.userId, 'userId'),
    username: safeString(input.username, 'unknown'),
    displayName: safeString(input.displayName, ''),
    title: requireNonEmptyString(input.title, 'title'),
    content: requireNonEmptyString(input.content, 'content'),
    staffChannelId: requireNonEmptyString(input.staffChannelId, 'staffChannelId'),
    createdAt: now,
    updatedAt: now,
  };

  const stmt = database.prepare(`
    INSERT INTO suggestions (
      guild_id,
      user_id,
      username,
      display_name,
      title,
      content,
      staff_channel_id,
      status,
      created_at,
      updated_at
    )
    VALUES (
      @guildId,
      @userId,
      @username,
      @displayName,
      @title,
      @content,
      @staffChannelId,
      'pending',
      @createdAt,
      @updatedAt
    )
  `);

  const result = stmt.run(data);

  return getSuggestionById(result.lastInsertRowid, options);
}

/**
 * 運営確認チャンネルへ送ったメッセージIDを保存する。
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.guildId
 * @param {string} input.staffMessageId
 * @param {object} [options]
 * @returns {boolean}
 */
export function setSuggestionStaffMessageId(input, options = {}) {
  const database = openSuggestionDb(options);

  const now = new Date().toISOString();

  const stmt = database.prepare(`
    UPDATE suggestions
    SET
      staff_message_id = @staffMessageId,
      updated_at = @updatedAt
    WHERE
      id = @id
      AND guild_id = @guildId
  `);

  const result = stmt.run({
    id: Number(input.id),
    guildId: requireNonEmptyString(input.guildId, 'guildId'),
    staffMessageId: requireNonEmptyString(input.staffMessageId, 'staffMessageId'),
    updatedAt: now,
  });

  return result.changes > 0;
}

/**
 * 投稿の対応状態を更新する。
 * 将来の「対応中」「対応済み」ボタン用。
 *
 * @param {object} input
 * @param {number} input.id
 * @param {string} input.guildId
 * @param {string} input.status
 * @param {object} [options]
 * @returns {boolean}
 */
export function setSuggestionStatus(input, options = {}) {
  const database = openSuggestionDb(options);

  const status = normalizeStatus(input.status);
  const now = new Date().toISOString();

  const stmt = database.prepare(`
    UPDATE suggestions
    SET
      status = @status,
      updated_at = @updatedAt
    WHERE
      id = @id
      AND guild_id = @guildId
  `);

  const result = stmt.run({
    id: Number(input.id),
    guildId: requireNonEmptyString(input.guildId, 'guildId'),
    status,
    updatedAt: now,
  });

  return result.changes > 0;
}

/**
 * 投稿IDから1件取得する。
 *
 * @param {number} id
 * @param {object} [options]
 * @returns {object | null}
 */
export function getSuggestionById(id, options = {}) {
  const database = openSuggestionDb(options);

  const row = database.prepare(`
    SELECT
      id,
      guild_id,
      user_id,
      username,
      display_name,
      title,
      content,
      staff_channel_id,
      staff_message_id,
      status,
      created_at,
      updated_at
    FROM suggestions
    WHERE id = ?
  `).get(Number(id));

  return rowToSuggestion(row);
}

/**
 * ギルド内の投稿を新しい順に取得する。
 * 将来の管理コマンド用。
 *
 * @param {string} guildId
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {object[]}
 */
export function listSuggestionsByGuild(guildId, options = {}) {
  const database = openSuggestionDb(options);

  const limit = clampInteger(options.limit ?? 20, 1, 100);

  const rows = database.prepare(`
    SELECT
      id,
      guild_id,
      user_id,
      username,
      display_name,
      title,
      content,
      staff_channel_id,
      staff_message_id,
      status,
      created_at,
      updated_at
    FROM suggestions
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(requireNonEmptyString(guildId, 'guildId'), limit);

  return rows.map(rowToSuggestion);
}

/**
 * DBを明示的に閉じる。
 * 普段は使わなくてOK。
 */
export function closeSuggestionDb() {
  if (db) {
    db.close();
    db = null;
    openedDbPath = null;
  }
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',

      title TEXT NOT NULL,
      content TEXT NOT NULL,

      staff_channel_id TEXT NOT NULL,
      staff_message_id TEXT,

      status TEXT NOT NULL DEFAULT 'pending',

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_suggestions_guild_id
      ON suggestions (guild_id);

    CREATE INDEX IF NOT EXISTS idx_suggestions_user_id
      ON suggestions (user_id);

    CREATE INDEX IF NOT EXISTS idx_suggestions_status
      ON suggestions (status);

    CREATE INDEX IF NOT EXISTS idx_suggestions_created_at
      ON suggestions (created_at);
  `);
}

function rowToSuggestion(row) {
  if (!row) return null;

  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    title: row.title,
    content: row.content,
    staffChannelId: row.staff_channel_id,
    staffMessageId: row.staff_message_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;

  const trimmed = value.trim();
  return trimmed || fallback;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[suggestions] ${name} is required`);
  }

  return value.trim();
}

function normalizeStatus(value) {
  const allowed = new Set([
    'pending',
    'in_progress',
    'done',
    'hold',
    'rejected',
  ]);

  if (typeof value !== 'string') return 'pending';

  const normalized = value.trim();

  if (!allowed.has(normalized)) {
    return 'pending';
  }

  return normalized;
}

function clampInteger(value, min, max) {
  const n = Number.parseInt(value, 10);

  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}