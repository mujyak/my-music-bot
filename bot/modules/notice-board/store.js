import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.resolve(
  process.cwd(),
  'data/notice-board/notice-board.sqlite'
);

const RETRY_DELAY_MS = 10 * 60 * 1000;

function compactError(err) {
  const message = err?.message ?? String(err);
  const code = err?.code ? ` code=${err.code}` : '';
  const status = err?.status ? ` status=${err.status}` : '';
  return `${message}${code}${status}`.slice(0, 500);
}

export function createNoticeBoardStore(
  dbPath = process.env.NOTICE_BOARD_DB_PATH ?? DEFAULT_DB_PATH
) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS notice_board_messages (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delete_at INTEGER NOT NULL,
      deleted_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notice_board_due
      ON notice_board_messages (deleted_at, delete_at, next_attempt_at);

    CREATE INDEX IF NOT EXISTS idx_notice_board_channel
      ON notice_board_messages (guild_id, channel_id);
  `);

  const upsert = db.prepare(`
    INSERT INTO notice_board_messages (
      message_id,
      guild_id,
      channel_id,
      created_at,
      delete_at,
      deleted_at,
      attempts,
      last_error,
      next_attempt_at,
      updated_at
    )
    VALUES (
      @messageId,
      @guildId,
      @channelId,
      @createdAt,
      @deleteAt,
      NULL,
      0,
      NULL,
      0,
      @updatedAt
    )
    ON CONFLICT(message_id) DO UPDATE SET
      guild_id = excluded.guild_id,
      channel_id = excluded.channel_id,
      created_at = excluded.created_at,
      delete_at = excluded.delete_at,
      updated_at = excluded.updated_at
  `);

  const getDueMessages = db.prepare(`
    SELECT
      message_id,
      guild_id,
      channel_id,
      created_at,
      delete_at,
      attempts,
      last_error
    FROM notice_board_messages
    WHERE deleted_at IS NULL
      AND delete_at <= ?
      AND next_attempt_at <= ?
    ORDER BY delete_at ASC
    LIMIT ?
  `);

  const markDeleted = db.prepare(`
    UPDATE notice_board_messages
    SET
      deleted_at = ?,
      last_error = NULL,
      updated_at = ?
    WHERE message_id = ?
  `);

  const markError = db.prepare(`
    UPDATE notice_board_messages
    SET
      attempts = attempts + 1,
      last_error = ?,
      next_attempt_at = ?,
      updated_at = ?
    WHERE message_id = ?
  `);

  return {
    upsertMessage({ messageId, guildId, channelId, createdAt, deleteAt }) {
      const now = Date.now();

      upsert.run({
        messageId: String(messageId),
        guildId: String(guildId),
        channelId: String(channelId),
        createdAt: Number(createdAt),
        deleteAt: Number(deleteAt),
        updatedAt: now
      });
    },

    getDueMessages(now = Date.now(), limit = 50) {
      return getDueMessages.all(now, now, limit);
    },

    markDeleted(messageId) {
      const now = Date.now();
      markDeleted.run(now, now, String(messageId));
    },

    markError(messageId, err) {
      const now = Date.now();
      const nextAttemptAt = now + RETRY_DELAY_MS;
      markError.run(compactError(err), nextAttemptAt, now, String(messageId));
    },

    close() {
      db.close();
    }
  };
}