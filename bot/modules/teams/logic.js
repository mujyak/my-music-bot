// チーム分けアルゴリズム（NGペア回避 *可能な範囲で*）
// 1) ランダムシャッフル
// 2) バックトラックで n 人枠へ順に詰める（入らなければ遡る）
// 3) 解けない場合は「衝突最小」ヒューリスティックにフォールバック
//    ※ NG情報は公開・通知しない。主催者にも知らせない（静粛運用）。

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function splitIntoTeams(participants, teamSize, ngPairsInput) {
  const users = shuffle(participants);
  // NGペアをセットへ（キーは昇順連結）
  const ng = new Set((ngPairsInput || []).map(([a,b]) => pairKey(a,b)));

  // チーム数（切り上げ）
  const teamCount = Math.ceil(users.length / teamSize);
  const caps = Array.from({ length: teamCount }, (_, i) =>
    i < teamCount - 1 ? teamSize : (users.length - teamSize * (teamCount - 1)) || teamSize
  );
  // 例：size=3, 8人 -> caps=[3,3,2]

  const teams = Array.from({ length: teamCount }, () => []);
  const used = new Set();

  // チェック：追加して衝突しないか
  function canPlace(uid, tIndex) {
    for (const m of teams[tIndex]) {
      if (ng.has(pairKey(uid, m))) return false;
    }
    return teams[tIndex].length < caps[tIndex];
  }

  // バックトラック
  function dfs(idx) {
    if (idx >= users.length) return true;
    const uid = users[idx];
    for (let t = 0; t < teamCount; t++) {
      if (canPlace(uid, t)) {
        teams[t].push(uid);
        used.add(uid);
        if (dfs(idx + 1)) return true;
        teams[t].pop();
        used.delete(uid);
      }
    }
    return false;
  }

  const ok = dfs(0);
  if (ok) return { teams, hadConflicts: false };

  // フォールバック：衝突最小貪欲（公開は黙って、主催者へだけ衝突発生を通知）
  const fallbackTeams = Array.from({ length: teamCount }, () => []);
  let ptr = 0;
  for (const uid of users) {
    // 入れられる場所で最小衝突数のチームへ
    let bestT = -1, bestCost = Infinity;
    for (let t = 0; t < teamCount; t++) {
      if (fallbackTeams[t].length >= caps[t]) continue;
      let cost = 0;
      for (const m of fallbackTeams[t]) {
        if (ng.has(pairKey(uid, m))) cost++;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestT = t;
      }
    }
    if (bestT === -1) {
      // 念のため（理論上起きない）
      bestT = ptr % teamCount;
      while (fallbackTeams[bestT].length >= caps[bestT]) bestT = (bestT + 1) % teamCount;
      ptr++;
    }
    fallbackTeams[bestT].push(uid);
  }
  return { teams: fallbackTeams, hadConflicts: true };
}
