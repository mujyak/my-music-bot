import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve(process.cwd(), 'data/notice-board/config.json');

const DEFAULT_DELETE_AFTER_DAYS = 7;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 1;

function daysToMs(days) {
  const n = Number(days);
  const safeDays = Number.isFinite(n) && n > 0 ? n : DEFAULT_DELETE_AFTER_DAYS;
  return Math.floor(safeDays * 24 * 60 * 60 * 1000);
}

export function loadNoticeBoardConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn(`[notice-board] config not found: ${CONFIG_PATH}`);
    return {
      enabled: false,
      boards: [],
      sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MINUTES * 60 * 1000,
      maxStartupScanMessages: 0
    };
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const enabled = raw.enabled !== false;
  const defaultDeleteAfterDays = raw.defaultDeleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS;
  const sweepIntervalMinutes = Number(raw.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES);
  const maxStartupScanMessages = Number(raw.maxStartupScanMessages ?? 0);

  const boards = [];

  for (const [guildId, guildConfig] of Object.entries(raw.guilds ?? {})) {
    if (guildConfig?.enabled === false) continue;

    const channels = Array.isArray(guildConfig?.channels) ? guildConfig.channels : [];

    for (const channelConfig of channels) {
      if (!channelConfig?.channelId) continue;

      const deleteAfterDays =
        channelConfig.deleteAfterDays ??
        guildConfig.deleteAfterDays ??
        defaultDeleteAfterDays;

      boards.push({
        guildId: String(guildId),
        channelId: String(channelConfig.channelId),
        deleteAfterDays: Number(deleteAfterDays),
        deleteAfterMs: daysToMs(deleteAfterDays)
      });
    }
  }

  return {
    enabled,
    boards,
    sweepIntervalMs: Math.max(1, sweepIntervalMinutes) * 60 * 1000,
    maxStartupScanMessages: Math.max(0, Math.floor(maxStartupScanMessages))
  };
}

export function findNoticeBoard(config, guildId, channelId) {
  if (!config?.enabled) return null;

  return config.boards.find(
    board => board.guildId === String(guildId) && board.channelId === String(channelId)
  ) ?? null;
}