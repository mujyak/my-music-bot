import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = { ngPairs: [] };

function ensurePath() {
  const p = path.resolve(process.cwd(), 'data', 'teams');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

export function loadNgPairs() {
  try {
    const dir = ensurePath();
    const file = path.join(dir, 'ng.json');
    if (!fs.existsSync(file)) return DEFAULT.ngPairs;
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const pairs = Array.isArray(json?.ngPairs) ? json.ngPairs : [];
    // 正規化：文字列ID2要素のみ通す
    return pairs.filter(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string'));
  } catch {
    return DEFAULT.ngPairs;
  }
}
