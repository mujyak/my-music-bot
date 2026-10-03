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

  // まず通常のテーブル定義（新規DBではここで全部揃う）
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_xp (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0,      -- 累計
      year_xp  INTEGER NOT NULL DEFAULT 0,      -- 当年
      year     INTEGER NOT NULL DEFAULT 1970,   -- 最後に更新した西暦（当年リセット用）
      msg_cd_until INTEGER NOT NULL DEFAULT 0,  -- メッセージXP用クールダウン（ms）
      vc_join_ts   INTEGER,                     -- VC入室時刻（ms）
      vc_session_ms INTEGER NOT NULL DEFAULT 0, -- 今セッションの累積在室ms
      vc_awarded_ms INTEGER NOT NULL DEFAULT 0, -- VC段階制: どこまでポイント換算済みか（ms）
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_userxp_guild_total ON user_xp(guild_id, total_xp DESC);
    CREATE INDEX IF NOT EXISTS idx_userxp_guild_year  ON user_xp(guild_id, year, year_xp DESC);
  `);

  // 既存DB救済：古いDBに vc_awarded_ms が無い場合でも落ちないように追加
  // （すでに列がある場合は例外になるので握りつぶす）
  try {
    db.exec('ALTER TABLE user_xp ADD COLUMN vc_awarded_ms INTEGER NOT NULL DEFAULT 0');
  } catch {}

  return db;
}

export function getOrInit(db, gid, uid) {
  const sel = db.prepare('SELECT * FROM user_xp WHERE guild_id=? AND user_id=?');
  let row = sel.get(gid, uid);
  if (!row) {
    db.prepare('INSERT INTO user_xp (guild_id,user_id,year) VALUES (?,?,?)')
      .run(gid, uid, new Date().getFullYear());
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

// ✅ ②: addXpで負の値にならないように clamp（0未満なら0へ）
export function addXp(db, gid, uid, delta) {
  ensureYearRow(db, gid, uid);

  // total_xp と year_xp をそれぞれ clamp
  // - total_xp: total_xp + delta が 0 未満なら 0
  // - year_xp : year_xp  + delta が 0 未満なら 0
  db.prepare(`
    UPDATE user_xp
    SET
      total_xp = CASE WHEN total_xp + ? < 0 THEN 0 ELSE total_xp + ? END,
      year_xp  = CASE WHEN year_xp  + ? < 0 THEN 0 ELSE year_xp  + ? END
    WHERE guild_id=? AND user_id=?
  `).run(delta, delta, delta, delta, gid, uid);

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
  db.prepare('UPDATE user_xp SET vc_join_ts=? WHERE guild_id=? AND user_id=?')
    .run(ts, gid, uid);
}
export function clearVcJoin(db, gid, uid) {
  db.prepare('UPDATE user_xp SET vc_join_ts=NULL WHERE guild_id=? AND user_id=?').run(gid, uid);
}

export function addVcSessionMs(db, gid, uid, deltaMs) {
  db.prepare('UPDATE user_xp SET vc_session_ms = vc_session_ms + ? WHERE guild_id=? AND user_id=?')
    .run(deltaMs, gid, uid);
}

// ✅ vc_awarded_ms を読む/書くための小物（xp.js側で使うなら便利）
export function setVcAwardedMs(db, gid, uid, ms) {
  db.prepare('UPDATE user_xp SET vc_awarded_ms=? WHERE guild_id=? AND user_id=?')
    .run(ms, gid, uid);
}
export function getVcAwardedMs(db, gid, uid) {
  return (db.prepare('SELECT vc_awarded_ms FROM user_xp WHERE guild_id=? AND user_id=?')
    .get(gid, uid)?.vc_awarded_ms) || 0;
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

export function setDeltaYearXp(db, gid, uid, delta) {
  // 管理コマンド用：当年XPだけ ±n を反映（累計は変えない）
  ensureYearRow(db, gid, uid);

  // year_xp だけ clamp（0未満なら0）
  db.prepare(`
    UPDATE user_xp
    SET
      year_xp = CASE WHEN year_xp + ? < 0 THEN 0 ELSE year_xp + ? END
    WHERE guild_id=? AND user_id=?
  `).run(delta, delta, gid, uid);

  // 念のため total_xp も一緒に返す（表示用）
  const row = db.prepare('SELECT total_xp, year_xp FROM user_xp WHERE guild_id=? AND user_id=?')
    .get(gid, uid);

  return row;
}

export function topTotal(db, gid, limit = 10) {
  return db.prepare('SELECT user_id,total_xp FROM user_xp WHERE guild_id=? ORDER BY total_xp DESC LIMIT ?')
    .all(gid, limit);
}
export function topYear(db, gid, limit = 10) {
  const y = new Date().getFullYear();
  return db.prepare('SELECT user_id,year_xp FROM user_xp WHERE guild_id=? AND year=? ORDER BY year_xp DESC LIMIT ?')
    .all(gid, y, limit);
}
export function getAllForRank(db, gid) {
  return db.prepare('SELECT user_id,total_xp FROM user_xp WHERE guild_id=? ORDER BY total_xp DESC').all(gid);
}
