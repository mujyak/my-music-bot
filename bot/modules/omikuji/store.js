// modules/omikuji/store.js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data/omikuji');
const DRAWS_PATH = path.join(DATA_DIR, 'draws.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * draws.json 構造:
 * db[guildId][season][userId] = record
 */
export function hasDrawn(guildId, userId, season) {
  const db = readJsonSafe(DRAWS_PATH, {});
  return !!db?.[guildId]?.[season]?.[userId];
}

export function getDrawRecord(guildId, userId, season) {
  const db = readJsonSafe(DRAWS_PATH, {});
  return db?.[guildId]?.[season]?.[userId] ?? null;
}

export function setDrawRecord(guildId, userId, season, record) {
  const db = readJsonSafe(DRAWS_PATH, {});
  db[guildId] ??= {};
  db[guildId][season] ??= {};
  db[guildId][season][userId] = record;
  writeJsonAtomic(DRAWS_PATH, db);
}
