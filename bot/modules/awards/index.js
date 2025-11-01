// modules/awards/index.js
import { buildNeotiCommands, buildFreebattleCommands } from "./commands.js";
import { handleAwardsInteraction } from "./interactions.js";
import { wireNeotiAuditHooks } from "./neoti.js";
import { wireFreebattleMessageHook } from "./freebattle.js";

// 公開 API
export function buildAwardCommands() {
  return [
    ...buildNeotiCommands(),
    ...buildFreebattleCommands(),
  ];
}

// 依存の配線（client のイベント購読など）
export function wireAwardHandlers(client) {
  wireNeotiAuditHooks(client);
  wireFreebattleMessageHook(client);
}

// interaction ディスパッチ（true を返したら処理済み）
export async function dispatchAwardInteraction(itx) {
  return handleAwardsInteraction(itx);
}

// アプリ側（大元の index.js）で使えるように setter を再エクスポート
export { setFreebattleConfig } from "./freebattle.js";
