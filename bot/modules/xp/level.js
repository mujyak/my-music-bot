export function levelFromTotal(totalXp) {
  const t = Math.max(0, Number(totalXp) || 0);
  // 5L^2 + 95L <= t を満たす最大の整数L
  // 解の公式: L = floor( (-95 + sqrt(95^2 + 20*t)) / 10 )
  const L = Math.floor((-95 + Math.sqrt(95 * 95 + 20 * t)) / 10);
  return Math.max(0, L);
}

export function xpToNextLevel(totalXp) {
  const t = Math.max(0, Number(totalXp) || 0);
  const L = levelFromTotal(t);
  const nextThreshold = totalXpForLevel(L + 1); // 次レベル到達に必要な累計
  return Math.max(0, nextThreshold - t);
}

export function totalXpForLevel(L) {
  const n = Math.max(0, Math.floor(L));
  return 5 * n * n + 95 * n;
}
