#!/usr/bin/env node
// scripts/omikuji-reset.js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data/omikuji');
const META_PATH = path.join(DATA_DIR, 'meta.json');
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

function usage(code = 0) {
  console.log(`
Usage:
  node scripts/omikuji-reset.js status
  node scripts/omikuji-reset.js set <season> [--guild <guildId>]
  node scripts/omikuji-reset.js clear [--season <season>] [--guild <guildId>]

Examples:
  node scripts/omikuji-reset.js status
  node scripts/omikuji-reset.js set 2026_newyear
  node scripts/omikuji-reset.js set 2026_newyear --guild 123456789012345678
  node scripts/omikuji-reset.js clear --season 2025_newyear
  node scripts/omikuji-reset.js clear --season 2025_newyear --guild 123456789012345678
`.trim());
  process.exit(code);
}

function getMeta() {
  ensureDir();
  return readJsonSafe(META_PATH, { globalSeason: 'default', guildSeason: {} });
}

function setMeta(meta) {
  writeJsonAtomic(META_PATH, meta);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guild') args.guild = argv[++i];
    else if (a === '--season') args.season = argv[++i];
    else args._.push(a);
  }
  return args;
}

function resolveActiveSeason(meta, guildId) {
  if (guildId && meta.guildSeason?.[guildId]) return meta.guildSeason[guildId];
  return meta.globalSeason || 'default';
}

function status() {
  const meta = getMeta();
  const db = readJsonSafe(DRAWS_PATH, {});
  const global = meta.globalSeason || 'default';

  console.log(`meta.json:`);
  console.log(`  globalSeason: ${global}`);
  console.log(`  guildSeason: ${Object.keys(meta.guildSeason || {}).length} entries`);

  // ざっくり集計（globalSeasonベース）
  let total = 0;
  for (const gid of Object.keys(db)) {
    const season = resolveActiveSeason(meta, gid);
    const n = Object.keys(db?.[gid]?.[season] || {}).length;
    total += n;
  }
  console.log(`\nDraw count (active season per guild): ${total}`);
}

function setSeason(season, guildId) {
  if (!season || !season.trim()) {
    console.error('season が空です');
    process.exit(1);
  }
  const meta = getMeta();
  meta.guildSeason ??= {};

  if (guildId) {
    meta.guildSeason[guildId] = season.trim();
    setMeta(meta);
    console.log(`OK: guild ${guildId} season => ${season.trim()}`);
  } else {
    meta.globalSeason = season.trim();
    setMeta(meta);
    console.log(`OK: globalSeason => ${season.trim()}`);
  }
}

function clearRecords(seasonOpt, guildIdOpt) {
  const meta = getMeta();
  const db = readJsonSafe(DRAWS_PATH, {});
  const targetSeason = seasonOpt?.trim() || null;

  const guildIds = guildIdOpt ? [guildIdOpt] : Object.keys(db);

  let removedUsers = 0;
  let touchedGuilds = 0;

  for (const gid of guildIds) {
    if (!db[gid]) continue;

    const season = targetSeason ?? resolveActiveSeason(meta, gid);
    const bucket = db?.[gid]?.[season];
    if (!bucket) continue;

    removedUsers += Object.keys(bucket).length;
    delete db[gid][season];
    touchedGuilds++;

    // ギルドが空になったら掃除
    if (Object.keys(db[gid]).length === 0) delete db[gid];
  }

  writeJsonAtomic(DRAWS_PATH, db);
  console.log(`OK: cleared records. guilds=${touchedGuilds}, users=${removedUsers}, season=${targetSeason ?? '(active per guild)'}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd) usage(1);

  if (cmd === 'status') {
    status();
    return;
  }

  if (cmd === 'set') {
    const season = args._[1];
    setSeason(season, args.guild);
    return;
  }

  if (cmd === 'clear') {
    clearRecords(args.season, args.guild);
    return;
  }

  usage(1);
}

main();

//全ギルド一斉に新シーズンへ切替
//sudo docker compose exec bot node scripts/omikuji-reset.js set 2026_newyear

//状態確認
//sudo docker compose exec bot node scripts/omikuji-reset.js status

//ギルド1つだけ別シーズンにする
//sudo docker compose exec bot node scripts/omikuji-reset.js set 2026_newyear --guild <GUILD_ID>

//記録自体を消す（通常は不要。事故対応用）
//sudo docker compose exec bot node scripts/omikuji-reset.js clear
