// modules/music/index.js
// 役割: 音楽モジュールの公開エントリ（依存注入・コマンド定義・イベント配線）
// - 外部（大元の index.js）から依存を受け取り glue に流し込む
// - SlashCommand のビルドと、interaction/イベント配線を束ねる
// - 二重配線を避けるための簡易ガードを持つ（idempotent）

import { installMusicGlue, useGlue } from './glue.js';
import { buildMusicSlashBuilders, handleInteraction } from './commands.js';
import { attachMusicEventWires } from './events.js';

let _wiredClientId = null; // 配線済みの Client を記録（多重 wire を抑止）

export function installMusicModule(deps = {}) {
  // 依存を注入（未注入でも動くように glue 側は no-op を持つ）
  // 期待キー: { client, shoukaku, sendNotice, sendToChannel, debugResolve, maxQueue }
  installMusicGlue(deps);

  // 軽い健全性チェック（落とさない・ログだけ）
  const {
    client,
    shoukaku,
    sendNotice,
    sendToChannel,
    debugResolve,
    maxQueue
  } = useGlue();

  if (!client) console.warn('[music/install] client is not provided');
  if (!shoukaku) console.warn('[music/install] shoukaku is not provided');
  if (typeof sendToChannel !== 'function') console.warn('[music/install] sendToChannel is not a function');
  if (typeof sendNotice !== 'function') console.warn('[music/install] sendNotice is not a function');
  if (typeof debugResolve !== 'boolean') console.warn('[music/install] debugResolve should be boolean');
  if (typeof maxQueue !== 'number') console.warn('[music/install] maxQueue should be number');
}

export function buildMusicCommands() {
  return buildMusicSlashBuilders();
}

export function wireMusicHandlers(client) {
  // 同じ Client に対しては一度だけ配線（events 側も WeakSet で多重防止しているが念のため）
  if (_wiredClientId && _wiredClientId === client.user?.id) {
    return;
  }
  attachMusicEventWires(client);
  _wiredClientId = client.user?.id ?? true; // user 未準備時でも二重配線を避ける
}

export async function dispatchMusicInteraction(itx) {
  return handleInteraction(itx);
}
