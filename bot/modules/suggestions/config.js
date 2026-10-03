// modules/suggestions/config.js
//
// トトロ目安箱機能の設定読み込み用ファイル。
// data/suggestions/config.json から、ギルドごとの設定を読み込む。
//
// 想定する config.json:
//
// {
//   "guilds": {
//     "YOUR_GUILD_ID": {
//       "enabled": true,
//       "boxChannelId": "BOX_CHANNEL_ID",
//       "staffChannelId": "STAFF_CHANNEL_ID"
//     }
//   }
// }

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = path.join(
  process.cwd(),
  'data',
  'suggestions',
  'config.json',
);

let cachedConfig = null;
let cachedConfigPath = null;

/**
 * 目安箱設定ファイルを読み込む。
 *
 * @param {object} options
 * @param {string} [options.configPath]
 * @param {boolean} [options.reload]
 * @returns {object}
 */
export function loadSuggestionConfig(options = {}) {
  const configPath =
    options.configPath ||
    process.env.SUGGESTIONS_CONFIG_PATH ||
    DEFAULT_CONFIG_PATH;

  const shouldReload =
    options.reload ||
    !cachedConfig ||
    cachedConfigPath !== configPath;

  if (!shouldReload) {
    return cachedConfig;
  }

  if (!fs.existsSync(configPath)) {
    console.warn(`[suggestions] config file not found: ${configPath}`);

    cachedConfig = {
      guilds: {},
    };
    cachedConfigPath = configPath;

    return cachedConfig;
  }

  try {
    const rawText = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawText);

    cachedConfig = normalizeConfig(parsed);
    cachedConfigPath = configPath;

    return cachedConfig;
  } catch (err) {
    console.error(`[suggestions] failed to load config: ${configPath}`, err);

    cachedConfig = {
      guilds: {},
    };
    cachedConfigPath = configPath;

    return cachedConfig;
  }
}

/**
 * 指定ギルドの目安箱設定を取得する。
 *
 * enabled が false、または設定が存在しない場合は null を返す。
 *
 * @param {string} guildId
 * @param {object} options
 * @param {string} [options.configPath]
 * @param {boolean} [options.reload]
 * @returns {object | null}
 */
export function getSuggestionGuildConfig(guildId, options = {}) {
  if (!guildId) return null;

  const config = loadSuggestionConfig(options);
  const guildConfig = config.guilds?.[guildId];

  if (!guildConfig) return null;
  if (!guildConfig.enabled) return null;

  return guildConfig;
}

/**
 * 指定ギルドで目安箱機能が有効かどうか。
 *
 * @param {string} guildId
 * @param {object} options
 * @returns {boolean}
 */
export function isSuggestionEnabled(guildId, options = {}) {
  return getSuggestionGuildConfig(guildId, options) !== null;
}

/**
 * 指定ギルドの窓口チャンネルIDを取得する。
 *
 * @param {string} guildId
 * @param {object} options
 * @returns {string | null}
 */
export function getSuggestionBoxChannelId(guildId, options = {}) {
  const guildConfig = getSuggestionGuildConfig(guildId, options);
  return guildConfig?.boxChannelId || null;
}

/**
 * 指定ギルドの運営確認チャンネルIDを取得する。
 *
 * @param {string} guildId
 * @param {object} options
 * @returns {string | null}
 */
export function getSuggestionStaffChannelId(guildId, options = {}) {
  const guildConfig = getSuggestionGuildConfig(guildId, options);
  return guildConfig?.staffChannelId || null;
}

/**
 * 設定ファイルの中身を最低限安全な形に整える。
 *
 * @param {object} parsed
 * @returns {object}
 */
function normalizeConfig(parsed) {
  const result = {
    guilds: {},
  };

  if (!parsed || typeof parsed !== 'object') {
    return result;
  }

  const guilds = parsed.guilds;

  if (!guilds || typeof guilds !== 'object') {
    return result;
  }

  for (const [guildId, rawGuildConfig] of Object.entries(guilds)) {
    if (!guildId || !rawGuildConfig || typeof rawGuildConfig !== 'object') {
      continue;
    }

    const enabled = rawGuildConfig.enabled !== false;

    const boxChannelId = normalizeSnowflake(rawGuildConfig.boxChannelId);
    const staffChannelId = normalizeSnowflake(rawGuildConfig.staffChannelId);

    result.guilds[guildId] = {
      enabled,
      boxChannelId,
      staffChannelId,
    };

    if (enabled && !boxChannelId) {
      console.warn(
        `[suggestions] boxChannelId is missing for guild: ${guildId}`,
      );
    }

    if (enabled && !staffChannelId) {
      console.warn(
        `[suggestions] staffChannelId is missing for guild: ${guildId}`,
      );
    }
  }

  return result;
}

/**
 * Discord IDっぽい値を文字列として整える。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeSnowflake(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed;
}