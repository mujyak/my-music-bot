import { loadRoleSyncConfig } from './config.js';

const INSTALL_KEY = Symbol.for('totoro.roleSyncInstalled');

/**
 * 同期処理から自動的に除外するロールかどうか
 */
function isExcludedRole(role, ignoredRoleIds) {
  if (!role) return true;

  // @everyone
  if (role.id === role.guild.id) {
    return true;
  }

  // JSONで指定された対象外ロール
  if (ignoredRoleIds.has(role.id)) {
    return true;
  }

  // Botロール、IntegrationロールなどDiscord管理ロール
  if (role.managed) {
    return true;
  }

  return false;
}

/**
 * ユーザーID -> 相方ユーザーID の検索テーブルを作る
 */
function buildPairMap(guildConfig) {
  const map = new Map();

  for (const pair of guildConfig.pairs) {
    map.set(pair.mainUserId, {
      pair,
      side: 'main',
      otherUserId: pair.subUserId
    });

    map.set(pair.subUserId, {
      pair,
      side: 'sub',
      otherUserId: pair.mainUserId
    });
  }

  return map;
}

/**
 * GuildMemberを取得
 */
async function fetchMember(guild, userId, force = false) {
  try {
    if (force) {
      return await guild.members.fetch({
        user: userId,
        force: true
      });
    }

    const cached = guild.members.cache.get(userId);

    if (cached) {
      return cached;
    }

    return await guild.members.fetch(userId);
  } catch (error) {
    console.warn(
      `[role-sync] メンバー取得失敗 guild=${guild.id} user=${userId}:`,
      error?.message ?? error
    );

    return null;
  }
}

/**
 * 指定されたMemberへロール差分を適用する
 */
async function applyRoleChanges({
  targetMember,
  rolesToAdd,
  rolesToRemove,
  reason
}) {
  if (rolesToAdd.length === 0 && rolesToRemove.length === 0) {
    return {
      added: 0,
      removed: 0
    };
  }

  if (!targetMember.manageable) {
    console.warn(
      `[role-sync] ${targetMember.user.tag} はBotから管理できないため同期できません`
    );

    return {
      added: 0,
      removed: 0
    };
  }

  let added = 0;
  let removed = 0;

  if (rolesToAdd.length > 0) {
    try {
      await targetMember.roles.add(rolesToAdd, reason);
      added = rolesToAdd.length;
    } catch (error) {
      console.error(
        `[role-sync] ロール追加失敗 user=${targetMember.id}:`,
        error
      );
    }
  }

  if (rolesToRemove.length > 0) {
    try {
      await targetMember.roles.remove(rolesToRemove, reason);
      removed = rolesToRemove.length;
    } catch (error) {
      console.error(
        `[role-sync] ロール削除失敗 user=${targetMember.id}:`,
        error
      );
    }
  }

  return {
    added,
    removed
  };
}

/**
 * 起動時同期
 *
 * mainを正としてsubを完全同期する。
 * ignoredRoleIdsに入っているロールは一切触らない。
 */
async function syncPairFromMain({
  guild,
  pair,
  guildConfig
}) {
  const ignoredRoleIds = new Set(guildConfig.ignoredRoleIds);

  const mainMember = await fetchMember(
    guild,
    pair.mainUserId,
    true
  );

  const subMember = await fetchMember(
    guild,
    pair.subUserId,
    true
  );

  if (!mainMember || !subMember) {
    console.warn(
      `[role-sync] 起動時同期をスキップ: ${pair.label}`
    );
    return;
  }

  const rolesToAdd = [];
  const rolesToRemove = [];

  for (const role of guild.roles.cache.values()) {
    if (isExcludedRole(role, ignoredRoleIds)) {
      continue;
    }

    const mainHas = mainMember.roles.cache.has(role.id);
    const subHas = subMember.roles.cache.has(role.id);

    // 既に一致している
    if (mainHas === subHas) {
      continue;
    }

    // Botより上のロールなど
    if (!role.editable) {
      console.warn(
        `[role-sync] 操作できないロールのためスキップ: ${role.name} (${role.id})`
      );
      continue;
    }

    if (mainHas) {
      rolesToAdd.push(role);
    } else {
      rolesToRemove.push(role);
    }
  }

  const result = await applyRoleChanges({
    targetMember: subMember,
    rolesToAdd,
    rolesToRemove,
    reason: `Role sync startup: ${pair.label}`
  });

  console.log(
    `[role-sync] 起動時同期 ${pair.label}: +${result.added} / -${result.removed}`
  );
}

/**
 * 登録されている全ペアを起動時同期
 */
async function runInitialSync(client, config) {
  console.log('[role-sync] 起動時ロール同期を開始します');

  for (const [guildId, guildConfig] of Object.entries(
    config.guilds
  )) {
    if (!guildConfig.enabled) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
      console.warn(
        `[role-sync] ギルドが見つかりません: ${guildId}`
      );
      continue;
    }

    for (const pair of guildConfig.pairs) {
      try {
        await syncPairFromMain({
          guild,
          pair,
          guildConfig
        });
      } catch (error) {
        console.error(
          `[role-sync] 起動時同期エラー ${pair.label}:`,
          error
        );
      }
    }
  }

  console.log('[role-sync] 起動時ロール同期が完了しました');
}

/**
 * guildMemberUpdateで変更されたロールを相方へ反映
 */
async function handleMemberUpdate({
  oldMember,
  newMember,
  guildConfig,
  pairMap
}) {
  const pairInfo = pairMap.get(newMember.id);

  // 登録されていないユーザー
  if (!pairInfo) {
    return;
  }

  const ignoredRoleIds = new Set(
    guildConfig.ignoredRoleIds
  );

  const guild = newMember.guild;

  const targetMember = await fetchMember(
    guild,
    pairInfo.otherUserId
  );

  if (!targetMember) {
    return;
  }

  const changedRoleIds = new Set([
    ...oldMember.roles.cache.keys(),
    ...newMember.roles.cache.keys()
  ]);

  const rolesToAdd = [];
  const rolesToRemove = [];

  for (const roleId of changedRoleIds) {
    const oldHas = oldMember.roles.cache.has(roleId);
    const newHas = newMember.roles.cache.has(roleId);

    // 変化していない
    if (oldHas === newHas) {
      continue;
    }

    const role = guild.roles.cache.get(roleId);

    if (!role) {
      continue;
    }

    if (isExcludedRole(role, ignoredRoleIds)) {
      continue;
    }

    if (!role.editable) {
      console.warn(
        `[role-sync] 操作できないロールのためスキップ: ${role.name} (${role.id})`
      );
      continue;
    }

    const targetHas = targetMember.roles.cache.has(roleId);

    /*
     * ここで既に同じ状態なら何もしない。
     *
     * これによって
     *
     * main -> subへ追加
     * ↓
     * subのguildMemberUpdate
     * ↓
     * mainには既に付いている
     * ↓
     * 何もしない
     *
     * となり無限ループを防げる。
     */

    if (newHas === targetHas) {
      continue;
    }

    if (newHas) {
      rolesToAdd.push(role);
    } else {
      rolesToRemove.push(role);
    }
  }

  if (
    rolesToAdd.length === 0 &&
    rolesToRemove.length === 0
  ) {
    return;
  }

  const direction =
    pairInfo.side === 'main'
      ? 'main -> sub'
      : 'sub -> main';

  const result = await applyRoleChanges({
    targetMember,
    rolesToAdd,
    rolesToRemove,
    reason: `Role sync ${direction}: ${pairInfo.pair.label}`
  });

  if (result.added > 0 || result.removed > 0) {
    console.log(
      `[role-sync] ${pairInfo.pair.label} ${direction}: +${result.added} / -${result.removed}`
    );
  }
}

/**
 * Role SyncをClientへ登録
 */
function setupRoleSync(client) {
  // 二重登録防止
  if (client[INSTALL_KEY]) {
    console.warn(
      '[role-sync] setupRoleSync() は既に登録されています'
    );
    return;
  }

  client[INSTALL_KEY] = true;

  let config;

  try {
    config = loadRoleSyncConfig();
  } catch (error) {
    console.error(
      '[role-sync] 設定ファイルの読み込みに失敗しました:',
      error
    );
    return;
  }

  if (!config.enabled) {
    console.log('[role-sync] 無効化されています');
    return;
  }

  const pairMaps = new Map();

  for (const [guildId, guildConfig] of Object.entries(
    config.guilds
  )) {
    pairMaps.set(
      guildId,
      buildPairMap(guildConfig)
    );
  }

  /*
   * リアルタイム同期
   */
  client.on(
    'guildMemberUpdate',
    async (oldMember, newMember) => {
      try {
        const guildConfig =
          config.guilds[newMember.guild.id];

        if (!guildConfig || !guildConfig.enabled) {
          return;
        }

        const pairMap = pairMaps.get(
          newMember.guild.id
        );

        if (!pairMap) {
          return;
        }

        await handleMemberUpdate({
          oldMember,
          newMember,
          guildConfig,
          pairMap
        });
      } catch (error) {
        console.error(
          '[role-sync] guildMemberUpdate処理中にエラー:',
          error
        );
      }
    }
  );

  /*
   * 起動時同期
   */
  const startInitialSync = async () => {
    try {
      await runInitialSync(client, config);
    } catch (error) {
      console.error(
        '[role-sync] 起動時同期処理に失敗しました:',
        error
      );
    }
  };

  if (client.isReady()) {
    void startInitialSync();
  } else {
    client.once('ready', () => {
      void startInitialSync();
    });
  }

  console.log('[role-sync] モジュールを登録しました');
}

export {
  setupRoleSync
};