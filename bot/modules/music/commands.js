// modules/music/commands.js
import { SlashCommandBuilder } from 'discord.js';
import { runWithGuildLock } from './locks.js';
import {
  playCommand,
  skipCommand,
  leaveCommand,
  queueCommand,
  loopCommand,
  loopQueueCommand,
  shuffleCommand
} from './service.js';
import { getState } from './state.js';
import { maybeForwardMusic } from './delegation.js';

const CMD = {
  PLAY: 'totoro_play',
  SKIP: 'totoro_skip',
  LEAVE: 'totoro_leave',
  QUEUE: 'totoro_queue',
  LOOP: 'totoro_loop',
  LOOP_QUEUE: 'totoro_loop_queue',
  SHUFFLE: 'totoro_shuffle'
};

export function buildMusicSlashBuilders() {
  return [
    new SlashCommandBuilder()
      .setName(CMD.PLAY)
      .setDescription('音楽を再生（YouTube）')
      .addStringOption(o =>
        o.setName('input').setDescription('URLまたはキーワード').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder().setName(CMD.SKIP).setDescription('次の曲へスキップ').toJSON(),
    new SlashCommandBuilder().setName(CMD.LEAVE).setDescription('退出').toJSON(),
    new SlashCommandBuilder().setName(CMD.QUEUE).setDescription('プレイリスト表示').toJSON(),
    new SlashCommandBuilder()
      .setName(CMD.LOOP)
      .setDescription('単曲ループ（skipで解除）')
      .addStringOption(o =>
        o.setName('input').setDescription('URLまたはキーワード').setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder().setName(CMD.LOOP_QUEUE).setDescription('全体ループ').toJSON(),
    new SlashCommandBuilder().setName(CMD.SHUFFLE).setDescription('シャッフル').toJSON()
  ];
}

export async function handleInteraction(itx) {
  const name = itx.commandName;
  if (!Object.values(CMD).includes(name)) return false;

  // 直前にメッセージしたテキストチャンネルを覚える
  getState(itx.guildId).lastTextChannelId = itx.channelId;

  await runWithGuildLock(itx.guildId, async () => {
    try {
      const q =
        name === CMD.PLAY
          ? itx.options.getString('input', true)
          : name === CMD.LOOP
            ? itx.options.getString('input', false)
            : undefined;

      // ★ここで1回だけ転送判定
      const forwarded = await maybeForwardMusic(itx, name, { q });
      if (forwarded) return;

      switch (name) {
        case CMD.PLAY: {
          const res = await playCommand({ itx, q });
          return itx.deferred ? itx.editReply(res) : itx.reply(res);
        }
        case CMD.SKIP: {
          const res = await skipCommand({ itx });
          return itx.reply(res);
        }
        case CMD.LEAVE: {
          const res = await leaveCommand({ itx });
          return itx.reply(res);
        }
        case CMD.QUEUE: {
          const res = await queueCommand({ itx });
          return itx.reply(res);
        }
        case CMD.LOOP: {
          const res = await loopCommand({ itx, q });
          return itx.deferred ? itx.editReply(res) : itx.reply(res);
        }
        case CMD.LOOP_QUEUE: {
          const res = await loopQueueCommand({ itx });
          return itx.reply(res);
        }
        case CMD.SHUFFLE: {
          const res = await shuffleCommand({ itx });
          return itx.reply(res);
        }
        default:
          return false;
      }
    } catch (e) {
      try {
        const msg = '処理に失敗したかも…無ジャ込みに報告してね';
        if (itx.deferred || itx.replied) {
          await itx.editReply(msg);
        } else {
          await itx.reply({ content: msg, ephemeral: true });
        }
      } catch {}
      console.error('[music/commands] handler failed', e);
    }
  });

  return true;
}
