import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(
  __dirname,
  '../../data/role-sync/config.json'
);

function requireId(value, name) {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(
      `[role-sync] ${name} は文字列のDiscord IDで指定してください: ${value}`
    );
  }

  return value;
}

function loadRoleSyncConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `[role-sync] 設定ファイルがありません: ${CONFIG_PATH}`
    );
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[role-sync] config.json の形式が不正です');
  }

  const result = {
    enabled: parsed.enabled !== false,
    guilds: {}
  };

  const guilds = parsed.guilds ?? {};

  for (const [guildId, guildConfig] of Object.entries(guilds)) {
    requireId(guildId, 'guildId');

    if (!guildConfig || typeof guildConfig !== 'object') {
      throw new Error(
        `[role-sync] ギルド ${guildId} の設定形式が不正です`
      );
    }

    const ignoredRoleIds = Array.isArray(guildConfig.ignoredRoleIds)
      ? guildConfig.ignoredRoleIds.map((roleId, index) =>
          requireId(
            roleId,
            `guilds.${guildId}.ignoredRoleIds[${index}]`
          )
        )
      : [];

    const rawPairs = Array.isArray(guildConfig.pairs)
      ? guildConfig.pairs
      : [];

    const pairs = [];
    const usedUserIds = new Set();

    for (let i = 0; i < rawPairs.length; i++) {
      const pair = rawPairs[i];

      if (!pair || typeof pair !== 'object') {
        throw new Error(
          `[role-sync] guilds.${guildId}.pairs[${i}] の形式が不正です`
        );
      }

      const mainUserId = requireId(
        pair.mainUserId,
        `guilds.${guildId}.pairs[${i}].mainUserId`
      );

      const subUserId = requireId(
        pair.subUserId,
        `guilds.${guildId}.pairs[${i}].subUserId`
      );

      if (mainUserId === subUserId) {
        throw new Error(
          `[role-sync] 本垢とサブ垢に同じIDは指定できません: ${mainUserId}`
        );
      }

      if (usedUserIds.has(mainUserId)) {
        throw new Error(
          `[role-sync] ユーザー ${mainUserId} が複数のペアに登録されています`
        );
      }

      if (usedUserIds.has(subUserId)) {
        throw new Error(
          `[role-sync] ユーザー ${subUserId} が複数のペアに登録されています`
        );
      }

      usedUserIds.add(mainUserId);
      usedUserIds.add(subUserId);

      pairs.push({
        label:
          typeof pair.label === 'string'
            ? pair.label
            : `${mainUserId} <-> ${subUserId}`,

        mainUserId,
        subUserId
      });
    }

    result.guilds[guildId] = {
      enabled: guildConfig.enabled !== false,
      ignoredRoleIds: [...new Set(ignoredRoleIds)],
      pairs
    };
  }

  return result;
}

export {
  loadRoleSyncConfig
};