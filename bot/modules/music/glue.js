// modules/music/glue.js
// 役割: 音楽モジュールの依存性をまとめて受け取り/配布する超薄いDIコンテナ。
// 実装本体（client/shoukaku/sendToChannel/sendNotice など）は大元の index.js 側で注入する。
// ここでは未注入でも落ちないように、どれも安全なダミー実装を入れておく。

/** @typedef {import('discord.js').Client} DjsClient */

let GLUE = {
  /** @type {DjsClient|null} */
  client: null,

  /** @type {any} Shoukaku instance */
  shoukaku: null,

  /**
   * 通知（テキストCHやVCのチャットへ投稿）: 注入されない限り何もしない
   * @param {string} _gid
   * @param {string} _content
   * @param {object} [_options]
   * @returns {Promise<boolean>} 送信できたら true
   */
  sendNotice: async () => false,

  /**
   * 任意のチャンネルへ直接送る（VCに送れた時だけ出す想定）
   * @param {string} _gid
   * @param {string} _channelId
   * @param {string} _content
   * @param {object} [_options]
   * @returns {Promise<boolean>} 送信できたら true
   */
  sendToChannel: async () => false,

  /** 楽曲解決などのデバッグログ出力フラグ */
  debugResolve: false,

  /** キュー上限 */
  maxQueue: 10
};

/**
 * index.js 側から依存を注入（shallow merge）
 * 例: installMusicGlue({ client, shoukaku, sendNotice, sendToChannel, debugResolve, maxQueue })
 * @param {Partial<typeof GLUE>} deps
 */
export function installMusicGlue(deps = {}) {
  GLUE = { ...GLUE, ...deps };
}

/** 依存を取得（モジュール内のどこからでも呼ぶ） */
export function useGlue() {
  return GLUE;
}
