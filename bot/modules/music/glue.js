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
   * 通知を送るための抽象関数。
   * 実体は大元の index.js 側で注入する。
   * どのチャンネルへ送るかは注入側の実装に委ねる。
   *
   * 想定呼び出し:
   *   sendNotice(gid, payload)
   *   sendNotice(gid, content, options)
   * など、注入実装に合わせて扱う。
   *
   * @param {string} _gid
   * @param {...any} _args
   * @returns {Promise<boolean>} 送信できたら true
   */
  sendNotice: async () => false,

  /**
   * 任意のチャンネルへ直接送る（主にVC/テキストチャンネル向け）
   * 実際の呼び出し形は sendToChannel(gid, channelId, payload)。
   * 3引数目には Discord の message payload
   * （例: { content }, { embeds: [...] }）をそのまま渡す。
   *
   * @param {string} _gid
   * @param {string} _channelId
   * @param {object} _payload Discord message payload
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
