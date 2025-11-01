// modules/music/commands.js
import { SlashCommandBuilder } from 'discord.js';
import { runWithGuildLock } from './locks.js';
import {
  playCommand,
  skipCommand,
  leaveCommand,
  queueCommand,
  loopCommand,
  loopQueueCommand
} from './service.js';
import { getState } from './state.js';

const CMD = {
  PLAY: 'totoro_play',
  SKIP: 'totoro_skip',
  LEAVE: 'totoro_leave',
  QUEUE: 'totoro_queue',
  LOOP: 'totoro_loop',
  LOOP_QUEUE: 'totoro_loop_queue'
};

export function buildMusicSlashBuilders() {
  return [
    new SlashCommandBuilder()
      .setName(CMD.PLAY)
      .setDescription('URLまたはキーワードで再生/追加（YouTubeのみ・単発）')
      .addStringOption(o =>
        o.setName('query').setDescription('URLまたはキーワード').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder().setName(CMD.SKIP).setDescription('次の曲へスキップ').toJSON(),
    new SlashCommandBuilder().setName(CMD.LEAVE).setDescription('退出＆キュークリア').toJSON(),
    new SlashCommandBuilder().setName(CMD.QUEUE).setDescription('キュー表示（先頭10件）').toJSON(),
    new SlashCommandBuilder().setName(CMD.LOOP).setDescription('単曲ループを切替').toJSON(),
    new SlashCommandBuilder().setName(CMD.LOOP_QUEUE).setDescription('キューループを切替').toJSON()
  ];
}

export async function handleInteraction(itx) {
  const name = itx.commandName;
  if (!Object.values(CMD).includes(name)) return false;

  // 直前にメッセージしたテキストチャンネルを覚える（将来の通知/埋め込みで使用）
  getState(itx.guildId).lastTextChannelId = itx.channelId;

  await runWithGuildLock(itx.guildId, async () => {
    try {
      switch (name) {
        case CMD.PLAY: {
          const q = itx.options.getString('query', true);
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
          const res = await loopCommand({ itx });
          return itx.reply(res);
        }
        case CMD.LOOP_QUEUE: {
          const res = await loopQueueCommand({ itx });
          return itx.reply(res);
        }
        default:
          return false;
      }
    } catch (e) {
      // ユーザー通知（失敗時に握り潰さない）
      try {
        if (itx.deferred) {
          await itx.editReply('処理に失敗したかも…ログを見てみてね。');
        } else {
          await itx.reply({ content: '処理に失敗したかも…', ephemeral: true });
        }
      } catch {}
      console.error('[music/commands] handler failed', e);
    }
  });

  return true;
}
