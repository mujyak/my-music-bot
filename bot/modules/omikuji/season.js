// modules/omikuji/season.js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data/omikuji');
const META_PATH = path.join(DATA_DIR, 'meta.json');

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

export function getMeta() {
  ensureDir();
  return readJsonSafe(META_PATH, { globalSeason: 'default', guildSeason: {} });
}

export function getActiveSeason(guildId) {
  const meta = getMeta();
  const gs = meta?.guildSeason?.[guildId];
  return (typeof gs === 'string' && gs.trim()) ? gs.trim()
    : (typeof meta?.globalSeason === 'string' && meta.globalSeason.trim()) ? meta.globalSeason.trim()
    : 'default';
}
