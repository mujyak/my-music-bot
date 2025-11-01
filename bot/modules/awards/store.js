// modules/awards/store.js
import fs from "node:fs";
import path from "node:path";

// それぞれ別ファイルで持つ（依存を分けたいので）
const FILES = {
  neoti: path.resolve("data/awards_neoti.json"),
  freebattle: path.resolve("data/awards_freebattle.json"),
};

// メモリキャッシュ
const CACHE = { neoti: null, freebattle: null };

function ensureDir() {
  fs.mkdirSync(path.resolve("data"), { recursive: true });
}

// ファイルからロード
function load(kind) {
  ensureDir();
  const file = FILES[kind];
  if (!fs.existsSync(file)) {
    CACHE[kind] = { meta: { year: new Date().getFullYear() }, data: {} };
    fs.writeFileSync(file, JSON.stringify(CACHE[kind], null, 2));
    return CACHE[kind];
  }
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf-8"));
    CACHE[kind] = json || { meta: { year: new Date().getFullYear() }, data: {} };
  } catch {
    CACHE[kind] = { meta: { year: new Date().getFullYear() }, data: {} };
  }
  return CACHE[kind];
}

function save(kind) {
  ensureDir();
  fs.writeFileSync(FILES[kind], JSON.stringify(CACHE[kind], null, 2));
}

// 内部: オブジェクト取得（guild -> user -> { total, year, yearStamp }）
function getMap(kind) {
  return CACHE[kind] ?? load(kind);
}

// 年チェック（ユーザーごとに年を跨いだら year=0 へ）
function touchYear(record) {
  const nowYear = new Date().getFullYear();
  if (record.yearStamp !== nowYear) {
    record.year = 0;
    record.yearStamp = nowYear;
  }
}

// パブリック API
export function incr(kind, guildId, userId, delta = 1) {
  const store = getMap(kind);
  store.data[guildId] ??= {};
  const rec = (store.data[guildId][userId] ??= { total: 0, year: 0, yearStamp: new Date().getFullYear() });
  touchYear(rec);
  rec.total += delta;
  rec.year += delta;
  save(kind);
  return { total: rec.total, year: rec.year };
}

export function setDelta(kind, guildId, userId, delta) {
  // 「±nに“する”」というより「±n を加算/減算」想定なので incr と同じ
  return incr(kind, guildId, userId, delta);
}

export function peek(kind, guildId, userId) {
  const store = getMap(kind);
  const rec = store.data?.[guildId]?.[userId] ?? { total: 0, year: 0, yearStamp: new Date().getFullYear() };
  touchYear(rec);
  return { total: rec.total, year: rec.year };
}

export function top(kind, guildId, limit = 10, which = "total") {
  const store = getMap(kind);
  const map = store.data?.[guildId] ?? {};
  const arr = Object.entries(map).map(([uid, r]) => {
    const tmp = { ...r };
    touchYear(tmp);
    return { userId: uid, total: tmp.total, year: tmp.year };
  });
  const key = which === "year" ? "year" : "total";
  return arr.sort((a, b) => b[key] - a[key]).slice(0, limit);
}
