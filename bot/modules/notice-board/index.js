import { Events } from 'discord.js';
import { loadNoticeBoardConfig, findNoticeBoard } from './config.js';
import { createNoticeBoardStore } from './store.js';

const SWEEP_BATCH_LIMIT = 50;

function log(...args) {
  console.log('[notice-board]', ...args);
}

function compactError(err) {
  const message = err?.message ?? String(err);
  const code = err?.code ? ` code=${err.code}` : '';
  const status = err?.status ? ` status=${err.status}` : '';
  return `${message}${code}${status}`;
}

async function fetchTextChannel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel) {
      log(`channel not found: ${channelId}`);
      return null;
    }

    if (!channel.isTextBased?.() || !channel.messages) {
      log(`channel is not a normal text-based message channel: ${channelId}`);
      return null;
    }

    return channel;
  } catch (err) {
    log(`failed to fetch channel ${channelId}:`, compactError(err));
    return null;
  }
}

function registerMessage(store, board, message) {
  const createdAt = message.createdTimestamp ?? Date.now();
  const deleteAt = createdAt + board.deleteAfterMs;

  store.upsertMessage({
    messageId: message.id,
    guildId: board.guildId,
    channelId: board.channelId,
    createdAt,
    deleteAt
  });

  return { createdAt, deleteAt };
}

async function deleteMessageObject(store, message, label = 'expired') {
  try {
    await message.delete();
    store.markDeleted(message.id);
    log(`deleted ${label} message: ${message.id}`);
    return true;
  } catch (err) {
    store.markError(message.id, err);
    log(`failed to delete message ${message.id}:`, compactError(err));
    return false;
  }
}

async function deleteTrackedRow(client, store, config, row) {
  const board = findNoticeBoard(config, row.guild_id, row.channel_id);

  // configから外したチャンネルの過去レコードは触らない
  if (!board) return;

  const channel = await fetchTextChannel(client, row.channel_id);
  if (!channel) {
    store.markError(row.message_id, new Error('Channel fetch failed'));
    return;
  }

  let message = null;

  try {
    message = await channel.messages.fetch(row.message_id);
  } catch (err) {
    // Discord API: Unknown Message
    // すでに手動削除されている場合など
    if (err?.code === 10008) {
      store.markDeleted(row.message_id);
      log(`message already gone: ${row.message_id}`);
      return;
    }

    store.markError(row.message_id, err);
    log(`failed to fetch message ${row.message_id}:`, compactError(err));
    return;
  }

  await deleteMessageObject(store, message, 'due');
}

async function sweepDueMessages(client, store, config) {
  let total = 0;

  while (true) {
    const rows = store.getDueMessages(Date.now(), SWEEP_BATCH_LIMIT);
    if (rows.length === 0) break;

    for (const row of rows) {
      await deleteTrackedRow(client, store, config, row);
      total++;
    }

    if (rows.length < SWEEP_BATCH_LIMIT) break;
  }

  if (total > 0) {
    log(`sweep finished: checked ${total} due messages`);
  }
}

async function syncOneBoard(client, store, config, board) {
  const channel = await fetchTextChannel(client, board.channelId);
  if (!channel) return;

  const now = Date.now();
  const maxScan = config.maxStartupScanMessages;
  let before = undefined;
  let scanned = 0;
  let registered = 0;
  let deleted = 0;

  log(`startup scan: guild=${board.guildId}, channel=${board.channelId}`);

  while (true) {
    if (maxScan > 0 && scanned >= maxScan) break;

    const remaining = maxScan > 0 ? maxScan - scanned : 100;
    const limit = Math.min(100, remaining);

    let messages;

    try {
      messages = await channel.messages.fetch({
        limit,
        ...(before ? { before } : {})
      });
    } catch (err) {
      log(`failed during startup scan channel=${board.channelId}:`, compactError(err));
      break;
    }

    if (!messages || messages.size === 0) break;

    const list = [...messages.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp
    );

    for (const message of list) {
      scanned++;

      const { deleteAt } = registerMessage(store, board, message);

      if (deleteAt <= now) {
        const ok = await deleteMessageObject(store, message, 'startup-expired');
        if (ok) deleted++;
      } else {
        registered++;
      }
    }

    before = list[list.length - 1]?.id;

    if (!before || messages.size < limit) break;
  }

  log(
    `startup scan done: channel=${board.channelId}, scanned=${scanned}, registered=${registered}, deleted=${deleted}`
  );
}

async function startupSync(client, store, config) {
  if (!config.enabled) {
    log('disabled by config');
    return;
  }

  if (config.boards.length === 0) {
    log('no notice boards configured');
    return;
  }

  for (const board of config.boards) {
    await syncOneBoard(client, store, config, board);
  }

  await sweepDueMessages(client, store, config);
}

export function initNoticeBoard(client) {
  const config = loadNoticeBoardConfig();
  const store = createNoticeBoardStore();

  let sweeping = false;

  async function safeSweep() {
    if (sweeping) return;

    sweeping = true;
    try {
      await sweepDueMessages(client, store, config);
    } catch (err) {
      log('sweep failed:', compactError(err));
    } finally {
      sweeping = false;
    }
  }

  client.on(Events.MessageCreate, async message => {
    if (!message.guildId) return;

    const board = findNoticeBoard(config, message.guildId, message.channelId);
    if (!board) return;

    // bot投稿も含めて「どんなメッセージも」対象にする。
    registerMessage(store, board, message);
  });

  client.on(Events.MessageDelete, message => {
    // 手動削除された場合もDB上では削除済みにしておく
    if (!message?.id) return;
    store.markDeleted(message.id);
  });

  const start = async () => {
    await startupSync(client, store, config);

    const timer = setInterval(() => {
      void safeSweep();
    }, config.sweepIntervalMs);

    timer.unref?.();

    log(
      `started: boards=${config.boards.length}, sweepIntervalMs=${config.sweepIntervalMs}`
    );
  };

  if (client.isReady()) {
    void start();
  } else {
    client.once(Events.ClientReady, () => {
      void start();
    });
  }

  return {
    sweepNow: safeSweep,
    close: () => store.close()
  };
}