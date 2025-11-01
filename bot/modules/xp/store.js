// modules/xp/store.js
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.XP_DB_PATH || path.resolve(process.cwd(), 'data/xp.sqlite');

export function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = wal');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_xp (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0,   -- 累計
      year_xp  INTEGER NOT NULL DEFAULT 0,   -- 当年
      year     INTEGER NOT NULL DEFAULT 1970, -- 最後に更新した西暦（当年リセット用）
      msg_cd_until INTEGER NOT NULL DEFAULT 0, -- メッセージXP用クールダウン（ms）
      vc_join_ts   INTEGER,                   -- VC入室時刻（ms）
      vc_session_ms INTEGER NOT NULL DEFAULT 0, -- 今セッションの累積在室ms
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_userxp_guild_total ON user_xp(guild_id, total_xp DESC);
    CREATE INDEX IF NOT EXISTS idx_userxp_guild_year  ON user_xp(guild_id, year, year_xp DESC);
  `);
  return db;
}

export function getOrInit(db, gid, uid) {
  const sel = db.prepare('SELECT * FROM user_xp WHERE guild_id=? AND user_id=?');
  let row = sel.get(gid, uid);
  if (!row) {
    db.prepare('INSERT INTO user_xp (guild_id,user_id,year) VALUES (?,?,?)').run(gid, uid, new Date().getFullYear());
    row = sel.get(gid, uid);
  }
  return row;
}

function ensureYearRow(db, gid, uid) {
  const y = new Date().getFullYear();
  const row = getOrInit(db, gid, uid);
  if (row.year !== y) {
    db.prepare('UPDATE user_xp SET year=?, year_xp=0 WHERE guild_id=? AND user_id=?').run(y, gid, uid);
  }
}

export function addXp(db, gid, uid, delta) {
  ensureYearRow(db, gid, uid);
  db.prepare('UPDATE user_xp SET total_xp = total_xp + ?, year_xp = year_xp + ? WHERE guild_id=? AND user_id=?')
    .run(delta, delta, gid, uid);
  const row = db.prepare('SELECT total_xp, year_xp FROM user_xp WHERE guild_id=? AND user_id=?').get(gid, uid);
  return row;
}

export function setMsgCooldown(db, gid, uid, untilMs) {
  db.prepare('UPDATE user_xp SET msg_cd_until=? WHERE guild_id=? AND user_id=?')
    .run(untilMs, gid, uid);
}
export function getMsgCooldown(db, gid, uid) {
  return (db.prepare('SELECT msg_cd_until FROM user_xp WHERE guild_id=? AND user_id=?')
    .get(gid, uid)?.msg_cd_until) || 0;
}

export function setVcJoin(db, gid, uid, ts) {
  db.prepare('UPDATE user_xp SET vc_join_ts=?, vc_session_ms=vc_session_ms WHERE guild_id=? AND user_id=?')
    .run(ts, gid, uid);
}
export function clearVcJoin(db, gid, uid) {
  db.prepare('UPDATE user_xp SET vc_join_ts=NULL WHERE guild_id=? AND user_id=?').run(gid, uid);
}
export function addVcSessionMs(db, gid, uid, deltaMs) {
  db.prepare('UPDATE user_xp SET vc_session_ms = vc_session_ms + ? WHERE guild_id=? AND user_id=?')
    .run(deltaMs, gid, uid);
}
export function takeVcSessionMs(db, gid, uid) {
  const row = db.prepare('SELECT vc_session_ms FROM user_xp WHERE guild_id=? AND user_id=?').get(gid, uid);
  const ms = row?.vc_session_ms || 0;
  db.prepare('UPDATE user_xp SET vc_session_ms=0 WHERE guild_id=? AND user_id=?').run(gid, uid);
  return ms;
}
export function peek(db, gid, uid) {
  return getOrInit(db, gid, uid);
}
export function setDeltaXp(db, gid, uid, delta) {
  // 管理コマンド用：±nを反映（年次にも同量反映）
  return addXp(db, gid, uid, delta);
}

export function topTotal(db, gid, limit=10) {
  return db.prepare('SELECT user_id,total_xp FROM user_xp WHERE guild_id=? ORDER BY total_xp DESC LIMIT ?')
    .all(gid, limit);
}
export function topYear(db, gid, limit=10) {
  const y = new Date().getFullYear();
  return db.prepare('SELECT user_id,year_xp FROM user_xp WHERE guild_id=? AND year=? ORDER BY year_xp DESC LIMIT ?')
    .all(gid, y, limit);
}
export function getAllForRank(db, gid) {
  return db.prepare('SELECT user_id,total_xp FROM user_xp WHERE guild_id=? ORDER BY total_xp DESC').all(gid);
}
