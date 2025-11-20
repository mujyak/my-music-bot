import fs from 'node:fs';
import path from 'node:path';

// JSONC（コメント付き）を許容するため簡易でコメント除去
function stripJsonComments(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // // ...
}

function ensureDir() {
  const p = path.resolve(process.cwd(), 'data', 'dice');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const DEFAULT_PHRASES = {
  "crit_fail_1":        ["…宇宙的失敗(；´Д`)"],
  "near_fail_2_5":      ["今日は流れ悪いかも…"],
  "low_6_20":           ["まだまだこれから！"],
  "mid_21_79":          ["可もなく不可もなく(　◜ω◝　)"],
  "high_80_94":         ["いい感じにノッてきた！"],
  "near_crit_95_99":    ["神は微笑んでいる…！"],
  "crit_100":           ["伝説達成。おめでとう！！"]
};

export function loadPhrases() {
  try {
    const dir = ensureDir();
    const file = path.join(dir, 'phrases.json');
    if (!fs.existsSync(file)) return DEFAULT_PHRASES;

    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(stripJsonComments(raw));
    const obj = (json && typeof json === 'object') ? json : {};

    // 各カテゴリは配列（文字列）に正規化。無ければデフォルト。
    const norm = {};
    for (const k of Object.keys(DEFAULT_PHRASES)) {
      const arr = Array.isArray(obj[k]) ? obj[k].filter(x => typeof x === 'string' && x.trim()) : [];
      norm[k] = arr.length ? arr : DEFAULT_PHRASES[k];
    }
    return norm;
  } catch {
    return DEFAULT_PHRASES;
  }
}
