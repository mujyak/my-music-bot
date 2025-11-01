// modules/xp/logic.js
// 段階: [0-60m):3m/pt, [60-120m):5m/pt, [120-180m):10m/pt, [180m-):15m/pt
export const MIN = 60_000;
export const SEGMENTS = [
  { until: 60 * MIN,  rateMinPerPt: 3 },
  { until: 120 * MIN, rateMinPerPt: 5 },
  { until: 180 * MIN, rateMinPerPt: 10 },
  { until: Infinity,  rateMinPerPt: 30 },
];

// 追加msを“どの帯域で消費するか”に分割してポイントを算出。
// speakingMultiplier は 1 or 2（ミュート解除なら2）
export function computeAwardPoints(priorSessionMs, addedMs, speakingMultiplier = 1) {
  let remain = Math.max(0, addedMs);
  let cursor = Math.max(0, priorSessionMs);
  let points = 0;

  for (const seg of SEGMENTS) {
    if (remain <= 0) break;
    if (cursor >= seg.until) continue;

    const segRoom = seg.until - cursor;           // この帯域に滞在できる残りms
    const use = Math.min(remain, segRoom);
    const rateMsPerPt = seg.rateMinPerPt * MIN;

    points += Math.floor(use / rateMsPerPt);
    remain -= use;
    cursor += use;
  }
  return Math.floor(points * speakingMultiplier);
}

// totalMs を最大限ポイント化した“後に残る端数ms”を計算
export function remainderMs(totalMs) {
  let remain = Math.max(0, totalMs);
  let cursor = 0;
  let leftover = 0;

  for (const seg of SEGMENTS) {
    if (remain <= 0) break;
    const segRoom = seg.until - cursor;
    if (segRoom <= 0) { cursor = seg.until; continue; }

    const use = Math.min(remain, segRoom);
    const rate = seg.rateMinPerPt * MIN;

    // この帯でポイント化できる分を取り切る
    const usedForPts = Math.floor(use / rate) * rate;
    leftover = use - usedForPts;       // この帯の端数が次帯域に跨がっても、“最後の帯の端数”が最終残り
    remain -= use;
    cursor += use;
  }
  return leftover; // 次tickへ持ち越す端数
}
