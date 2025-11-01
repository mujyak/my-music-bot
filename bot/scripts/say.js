#!/usr/bin/env node
import { REST, Routes } from 'discord.js';

function parseAllowedGuilds(str) {
  if (!str) return null; // 未設定なら全許可（既存運用に合わせる）
  return str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

async function readFromStdin() {
  return await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function parseArgs(argv) {
  // 形式:
  // node scripts/say.js <channelId> [--reply|-r <messageId>] <message...>
  const out = { channelId: null, replyId: null, messageParts: [] };
  const args = [...argv];

  if (args.length === 0) return out;
  out.channelId = args.shift();

  while (args.length) {
    const a = args[0];
    if (a === '--reply' || a === '-r') {
      args.shift();
      const id = args.shift();
      if (!id) {
        console.error('Error: --reply requires a <messageId>.');
        process.exit(1);
      }
      out.replyId = id;
      continue;
    }
    // 残りはすべてメッセージ
    out.messageParts = args.slice();
    break;
  }
  return out;
}

async function main() {
  const { channelId, replyId, messageParts } = parseArgs(process.argv.slice(2));

  if (!channelId) {
    console.error('Usage: node scripts/say.js <channelId> [--reply|-r <messageId>] <message...>\n' +
                  '       node scripts/say.js <channelId> [--reply|-r <messageId>] -  # read from stdin');
    process.exit(1);
  }

  let content;
  if (messageParts.length === 1 && messageParts[0] === '-') {
    content = await readFromStdin();
  } else {
    content = messageParts.join(' ');
  }

  if (!content) {
    console.error('Empty message. Provide text or use "-" and pipe from stdin.');
    process.exit(1);
  }
  if (content.length > 2000) {
    console.error('Message too long (max 2000 chars).');
    process.exit(1);
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN is not set.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  // チャンネルの所属ギルドを確認（誤投下防止）
  let channel;
  try {
    channel = await rest.get(Routes.channel(channelId));
  } catch (e) {
    console.error('Failed to fetch channel:', e?.message || e);
    process.exit(1);
  }
  const guildId = channel.guild_id; // DMはundefined

  const allow = parseAllowedGuilds(process.env.ALLOW_GUILDS);
  if (allow && guildId && !allow.includes(guildId)) {
    console.error(`This channel's guild (${guildId}) is not in ALLOW_GUILDS. Aborting.`);
    process.exit(1);
  }

  // 返信先メッセージが指定されたら、存在確認（同一チャンネル内）を実施
  if (replyId) {
    try {
      await rest.get(Routes.channelMessage(channelId, replyId));
    } catch (e) {
      console.error(`Failed to fetch target message ${replyId} in channel ${channelId}:`, e?.message || e);
      process.exit(1);
    }
  }

  // 送信（Botに当該チャンネルの発言権限が必要）
  try {
    const body = {
      content,
      // 返信時は元投稿者を自動でメンションしない
      allowed_mentions: { replied_user: false },
    };
    if (replyId) {
      body.message_reference = {
        message_id: replyId,
        channel_id: channelId,
        guild_id: guildId ?? undefined,
      };
    }

    const created = await rest.post(Routes.channelMessages(channelId), { body });
    const mode = replyId ? `reply to ${replyId}` : 'new message';
    console.log(`Sent ${mode} ${created.id} to #${channel.name ?? channelId} (guild ${guildId ?? 'DM'}).`);
  } catch (e) {
    console.error('Failed to send message:', e?.message || e);
    process.exit(1);
  }
}

main();

/*
============================================================
Usage: scripts/say.js  —  トトロbot 管理用CLI（発言/返信）
------------------------------------------------------------

　cd /home/ubuntu/my-music-bot
　sudo docker compose exec -T bot node scripts/say.js <channelId> 'テスト投稿'
　sudo docker compose exec -T bot node scripts/say.js <channelId> -r <messageId> 'この投稿に返信します'


注意:
  - メッセージ上限は2000文字（超過でエラー終了）。
  - 返信対象は同一チャンネル内のmessageIdを指定してください。
  - 返信時の自動メンションは無効（allowed_mentions.replied_user=false）。
    必要なら本文に <@userId> を含めて手動でメンションしてください。
  - 誤投下防止のため、環境変数 ALLOW_GUILDS に指定のないギルドの
    チャンネルIDはブロックされます（未設定なら全許可）。
  - 実行には DISCORD_TOKEN が必要。Botに該当チャンネルの送信権限が必要。

運用例（Docker Compose）:
  sudo docker compose exec -T bot node scripts/say.js <channelId> 'text'
  printf '行1\n行2\n' | sudo docker compose exec -T bot node scripts/say.js <channelId> -
  sudo docker compose exec -T bot node scripts/say.js <channelId> -r <messageId> 'reply text'
============================================================
*/
