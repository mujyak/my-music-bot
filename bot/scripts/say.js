#!/usr/bin/env node
import { REST, Routes } from 'discord.js';

const ALLOWED_MENTIONS = {
  // 本文中の <@userId> / <@&roleId> / @everyone / @here を有効化する
  parse: ['users', 'roles', 'everyone'],

  // 返信時に「返信先メッセージの投稿者」を自動メンションしない
  replied_user: false,
};

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

function normalizeProfile(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'totoro') return 'totoro';
  if (s === 'nakatoro') return 'nakatoro';
  if (s === 'kototoro' || s === 'kotoro') return 'kototoro';
  return null;
}

function pickEnvByProfile(profile) {
  // kototoro だが env の接頭辞は KOTORO_（既存index.jsと同じ）
  if (profile === 'totoro') {
    return {
      token: process.env.TOTORO_DISCORD_TOKEN ?? process.env.DISCORD_TOKEN,
      allow: process.env.TOTORO_ALLOW_GUILDS ?? process.env.ALLOW_GUILDS,
    };
  }

  if (profile === 'nakatoro') {
    return {
      token: process.env.NAKATORO_DISCORD_TOKEN ?? process.env.DISCORD_TOKEN,
      allow: process.env.NAKATORO_ALLOW_GUILDS ?? process.env.ALLOW_GUILDS,
    };
  }

  if (profile === 'kototoro') {
    return {
      token: process.env.KOTORO_DISCORD_TOKEN ?? process.env.KOTOTORO_DISCORD_TOKEN ?? process.env.DISCORD_TOKEN,
      allow: process.env.KOTORO_ALLOW_GUILDS ?? process.env.KOTOTORO_ALLOW_GUILDS ?? process.env.ALLOW_GUILDS,
    };
  }

  return {
    token: process.env.DISCORD_TOKEN,
    allow: process.env.ALLOW_GUILDS,
  };
}

function parseArgs(argv) {
  // 形式:
  // node scripts/say.js [--profile|-p totoro|nakatoro|kototoro] <channelId> [--reply|-r <messageId>] <message...>
  // node scripts/say.js [--profile|-p ...] <channelId> [--edit|-e <messageId>] <message...>
  const out = {
    profile: null,
    channelId: null,
    replyId: null,
    editId: null,
    messageParts: [],
  };

  const args = [...argv];

  while (args.length) {
    const a = args[0];

    if (a === '--profile' || a === '-p') {
      args.shift();
      const p = normalizeProfile(args.shift());
      if (!p) {
        console.error('Error: --profile must be one of totoro|nakatoro|kototoro.');
        process.exit(1);
      }
      out.profile = p;
      continue;
    }

    // channelId は最初に出てくる非オプションを採用
    if (!out.channelId && !a.startsWith('-')) {
      out.channelId = args.shift();
      continue;
    }

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

    if (a === '--edit' || a === '-e') {
      args.shift();
      const id = args.shift();
      if (!id) {
        console.error('Error: --edit requires a <messageId>.');
        process.exit(1);
      }
      out.editId = id;
      continue;
    }

    // 残りはすべてメッセージ
    out.messageParts = args.slice();
    break;
  }

  return out;
}

async function main() {
  const {
    profile: argProfile,
    channelId,
    replyId,
    editId,
    messageParts,
  } = parseArgs(process.argv.slice(2));

  if (!channelId) {
    console.error(
      'Usage: node scripts/say.js [--profile|-p totoro|nakatoro|kototoro] <channelId> [--reply|-r <messageId>] <message...>\n' +
      '       node scripts/say.js [--profile|-p totoro|nakatoro|kototoro] <channelId> [--edit|-e <messageId>] <message...>\n' +
      '       node scripts/say.js [--profile|-p ...] <channelId> [--reply|-r <messageId>] -  # read from stdin\n' +
      '       node scripts/say.js [--profile|-p ...] <channelId> [--edit|-e <messageId>] -  # read from stdin'
    );
    process.exit(1);
  }

  if (replyId && editId) {
    console.error('Error: --reply and --edit cannot be used together.');
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

  const profile = argProfile ?? normalizeProfile(process.env.BOT_PROFILE) ?? 'totoro';
  const { token, allow } = pickEnvByProfile(profile);

  if (!token) {
    console.error(`DISCORD token is not set for profile=${profile}. (expected per-bot token or DISCORD_TOKEN)`);
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

  const allowList = parseAllowedGuilds(allow);
  if (allowList && guildId && !allowList.includes(guildId)) {
    console.error(`This channel's guild (${guildId}) is not allowed. Aborting. (profile=${profile})`);
    process.exit(1);
  }

  // 編集モード
  if (editId) {
    // Bot自身のID取得（本人の発言かチェック用）
    let me;
    try {
      me = await rest.get(Routes.user('@me'));
    } catch (e) {
      console.error('Failed to fetch bot user (@me):', e?.message || e);
      process.exit(1);
    }

    const myId = me?.id;

    // 対象メッセージ取得（同一チャンネル内）
    let target;
    try {
      target = await rest.get(Routes.channelMessage(channelId, editId));
    } catch (e) {
      console.error(`Failed to fetch target message ${editId} in channel ${channelId}:`, e?.message || e);
      process.exit(1);
    }

    if (!target?.author?.id || target.author.id !== myId) {
      console.error('This message was not posted by the bot. Editing is not allowed. Aborting.');
      process.exit(1);
    }

    try {
      const patched = await rest.patch(Routes.channelMessage(channelId, editId), {
        body: {
          content,
          allowed_mentions: ALLOWED_MENTIONS,
        },
      });

      console.log(`Edited ${patched.id} in #${channel.name ?? channelId} (guild ${guildId ?? 'DM'}) profile=${profile}.`);
    } catch (e) {
      console.error('Failed to edit message:', e?.message || e);
      process.exit(1);
    }

    return;
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

  // 送信
  try {
    const body = {
      content,

      // 本文中のユーザー/ロール/@everyone/@here メンションは有効。
      // ただし返信時の「元投稿者への自動メンション」は抑止する。
      allowed_mentions: ALLOWED_MENTIONS,
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

    console.log(`Sent ${mode} ${created.id} to #${channel.name ?? channelId} (guild ${guildId ?? 'DM'}) profile=${profile}.`);
  } catch (e) {
    console.error('Failed to send message:', e?.message || e);
    process.exit(1);
  }
}

main();

/*
============================================================
Usage: scripts/say.js  —  トトロbot 管理用CLI（発言/返信/編集）
（Totoro / 中トトロ / 小トトロ 対応版）
------------------------------------------------------------

  cd /home/ubuntu/my-music-bot

# ----------------------------------------------------------
# 実行の基本（おすすめ）
#   「喋らせたいBotのコンテナ」で実行するのが一番ラク
#   （BOT_PROFILE が自動で効くので --profile 不要）
# ----------------------------------------------------------

  # Totoro で投稿
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> 'テスト投稿'

  # 中トトロ で投稿
  sudo docker compose exec -T bot_nakatoro node scripts/say.js <channelId> '中トトロだよ'

  # 小トトロ で投稿
  sudo docker compose exec -T bot_kototoro node scripts/say.js <channelId> '小トトロだよ'

# ----------------------------------------------------------
# @everyone / @here / ユーザー / ロールメンション
# ----------------------------------------------------------

  # @everyone
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> '@everyone お知らせです'

  # @here
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> '@here 今いる人向けのお知らせです'

  # ユーザーメンション
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> '<@userId> 呼び出しです'

  # ロールメンション
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> '<@&roleId> お知らせです'

  ※ このスクリプトでは allowed_mentions に
     users / roles / everyone を常時許可しています。
     そのため、本文中の @everyone / @here / <@userId> / <@&roleId> は
     Discord側の権限が許す範囲でメンションとして有効になります。

  ※ @everyone / @here を飛ばすには、Botのロールに
     「@everyone、@here、すべてのロールにメンション」
     権限が必要です。
     チャンネル個別権限で拒否されている場合は、そちらが優先されます。

# ----------------------------------------------------------
# どのコンテナからでも --profile で指定できる
# ----------------------------------------------------------

  # Totoroコンテナから中トトロ指定で投稿（例）
  sudo docker compose exec -T bot_totoro node scripts/say.js --profile nakatoro <channelId> '中トトロ代行です'

  # 省略時は「BOT_PROFILE（なければ totoro）」を使う
  # --profile は: totoro / nakatoro / kototoro（kotoro でも可）

# ----------------------------------------------------------
# 返信
# ----------------------------------------------------------

  # 返信（短縮）
  sudo docker compose exec -T bot_nakatoro node scripts/say.js <channelId> -r <messageId> 'この投稿に返信します'

  # 返信（ロング）
  sudo docker compose exec -T bot_nakatoro node scripts/say.js <channelId> --reply <messageId> 'この投稿に返信します'

  # 返信しつつ @everyone
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> -r <messageId> '@everyone 返信形式のお知らせです'

  ※ 返信時でも、本文に含めたメンションは有効です。
     ただし「返信先メッセージの投稿者」への自動メンションは無効です。
     allowed_mentions.replied_user=false にしています。

# ----------------------------------------------------------
# 編集
#   ※編集は「そのBot自身が投稿したメッセージ」のみ可能
# ----------------------------------------------------------

  # 編集（短縮）
  sudo docker compose exec -T bot_kototoro node scripts/say.js <channelId> -e <messageId> '更新後のテキスト'

  # 編集（ロング）
  sudo docker compose exec -T bot_kototoro node scripts/say.js <channelId> --edit <messageId> '更新後のテキスト'

  # 編集でメンションを含めることも可能
  sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> -e <messageId> '@everyone 更新しました'

  ※ ただし、通知目的の @everyone / @here は新規投稿の方が確実です。
     編集で後からメンションを足した場合の通知挙動は分かりにくいため、
     緊急告知などは通常投稿を推奨します。

# ----------------------------------------------------------
# stdin（複数行）: メッセージに "-" を渡す
# ----------------------------------------------------------

  # 通常投稿（stdin）
  printf '行1\n行2\n' | sudo docker compose exec -T bot_totoro node scripts/say.js <channelId> -

  # 返信（stdin）
  printf '行1\n行2\n' | sudo docker compose exec -T bot_nakatoro node scripts/say.js <channelId> -r <messageId> -

  # 編集（stdin）
  printf '行1\n行2\n' | sudo docker compose exec -T bot_kototoro node scripts/say.js <channelId> -e <messageId> -

# ----------------------------------------------------------
# 注意
# ----------------------------------------------------------

  - メッセージ上限は2000文字（超過でエラー終了）。
  - 返信対象/編集対象は同一チャンネル内のmessageIdを指定してください。
  - 編集は「実行したBot自身が投稿したメッセージ」のみ可能です。
    それ以外のメッセージを編集しようとすると拒否します。
  - 本文中のユーザー/ロール/@everyone/@here メンションは有効です。
  - 返信時の「元投稿者への自動メンション」は無効です。
  - 誤投下防止のため、各Botの ALLOW_GUILDS に指定のないギルドの
    チャンネルIDはブロックされます（未設定なら全許可）。
    - Totoro:   TOTORO_ALLOW_GUILDS
    - 中トトロ: NAKATORO_ALLOW_GUILDS
    - 小トトロ: KOTORO_ALLOW_GUILDS
  - トークンは各Botのものを使用します（profileごとに切替）。
    - Totoro:   TOTORO_DISCORD_TOKEN
    - 中トトロ: NAKATORO_DISCORD_TOKEN
    - 小トトロ: KOTORO_DISCORD_TOKEN
  - 小トトロのprofile名は内部的には kototoro ですが、
    --profile kotoro でも指定できます。

============================================================
*/