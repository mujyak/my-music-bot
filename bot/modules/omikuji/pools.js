// modules/omikuji/pools.js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data/omikuji');
const POOLS_PATH = path.join(DATA_DIR, 'pools.json');
const EXAMPLE_PATH = path.join(DATA_DIR, 'pools.example.json');

function readJsonSafe(filePath) {
  try {
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function loadPools() {
  // pools.json があればそれを優先（運用向け）
  const primary = readJsonSafe(POOLS_PATH);
  if (primary) return primary;

  // なければ example を読む（初回向け）
  const example = readJsonSafe(EXAMPLE_PATH);
  if (example) return example;

  // 最低限のフォールバック
  return {
    mainResults: [{ key: 'kichi', label: '吉', weight: 1 }],
    categories: [{ key: 'health', label: '健康' }],
    default: { health: [{ text: '（データ未設定）', weight: 1 }] },
    pools: {}
  };
}

export function pickWeighted(items) {
  // items: [{weight, ...}]
  const arr = Array.isArray(items) ? items : [];
  const total = arr.reduce((a, x) => a + (Number(x?.weight) > 0 ? Number(x.weight) : 0), 0);
  if (total <= 0) return arr[0] ?? null;

  let r = Math.random() * total;
  for (const it of arr) {
    const w = Number(it?.weight);
    if (!(w > 0)) continue;
    r -= w;
    if (r < 0) return it;
  }
  return arr[arr.length - 1] ?? null;
}

export function drawOmikuji(poolsData) {
  const main = pickWeighted(poolsData.mainResults);
  const mainKey = main?.key ?? 'kichi';
  const mainLabel = main?.label ?? '吉';

  const resultsByCategory = {};
  for (const cat of poolsData.categories ?? []) {
    const key = cat.key;
    const pool =
      poolsData?.pools?.[mainKey]?.[key] ??
      poolsData?.default?.[key] ??
      [{ text: '（未設定）', weight: 1 }];

    const picked = pickWeighted(pool);
    resultsByCategory[key] = picked?.text ?? '（未設定）';
  }

  return {
    mainKey,
    mainLabel,
    resultsByCategory
  };
}
