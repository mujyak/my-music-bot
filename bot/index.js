import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';

// ---- env ----
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, LAVALINK_PASSWORD, ALLOW_GUILDS } = process.env;
const ALLOW = (ALLOW_GUILDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ---- lavalink node(s) ----
const NODES = [
  { name: 'main', url: 'lavalink:2333', auth: LAVALINK_PASSWORD, secure: false }
];

// ---- slash commands ----
const commands = [
  new SlashCommandBuilder()
    .setName('totoro_play')
    .setDescription('URLまたはキーワード（複数可・スペース/改行区切り）で再生/追加')
    .addStringOption(o => o.setName('query').setDescription('URLまたはキーワード').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('totoro_skip').setDescription('次の曲へスキップ').toJSON(),
  new SlashCommandBuilder().setName('totoro_loop').setDescription('今の曲を単曲ループ').toJSON(),
  new SlashCommandBuilder().setName('totoro_loop_queue').setDescription('キュー全体をループ').toJSON(),
  new SlashCommandBuilder().setName('totoro_loop_pueue').setDescription('（エイリアス）キュー全体をループ').toJSON(),
  new SlashCommandBuilder().setName('totoro_leave').setDescription('退出＆キュークリア').toJSON(),
  new SlashCommandBuilder().setName('totoro_queue').setDescription('キュー表示（先頭10件）').toJSON()
];

// ---- register commands (guild) ----
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });

// ---- discord client & shoukaku ----
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), NODES, {
  moveOnDisconnect: false, resumable: true, resumableTimeout: 60
});
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

// ---- state ----
const states = new Map(); // guildId -> { conn, queue, current, loop, playing }
function getState(gid) {
  if (!states.has(gid)) {
    states.set(gid, { conn: null, queue: [], current: null, loop: 'off', playing: false });
  }
  return states.get(gid);
}
function getVoiceChannelId(i) {
  return i.member?.voice?.channelId
      || i.guild?.voiceStates?.cache?.get(i.user.id)?.channelId
      || null;
}
// ---- voice connect (Shoukaku v4) ----
async function ensureConnectionV4(gid, channelId) {
  const s = getState(gid);
  const node = shoukaku.nodes.get('main') ?? [...shoukaku.nodes.values()][0];

  // 別VCに居たら作り直し
  if (s.conn && s.conn.channelId && s.conn.channelId !== channelId) {
    try { await s.conn.leaveChannel(); } catch {}
    s.conn = null;
  }
  if (!s.conn) {
   s.conn = await shoukaku.joinVoiceChannel({
      guildId: gid,
      channelId,
      shardId: 0,
      nodeName: node.name,
      // 明示しておく：聞こえなくするのはOK（自分ミュートはNG）
      deaf: true,
      mute: false
    });
    // 念のため：接続直後に self-mute を解除（server mute には効かない）
    try { await s.conn.setMute(false); } catch {}
    // player events
    s.conn.on('end', async () => {
      const st = getState(gid);
      if (st.loop === 'track' && st.current) { await st.conn.playTrack({ track: st.current.encoded }); return; }
      if (st.loop === 'queue' && st.current) { st.queue.push(st.current); }
      st.current = null; st.playing = false;
      playNext(gid).catch(() => {});
    });
    s.conn.on('error', (e) => console.error(`[PlayerError][${gid}]`, e));
  }
  return s.conn;
}
// ---- play next ----
async function playNext(gid) {
  const s = getState(gid);
  if (s.playing) return;
  const next = s.queue.shift();
  if (!next) return;
  s.current = next;
  s.playing = true;
  await s.conn.playTrack({ track: next.encoded });
}

// ---- query helper ----
function parseQueries(input) {
  const parts = input.split(/\s+/).map(x => x.trim()).filter(Boolean).slice(0, 10);
  if (parts.length === 0) return [];
  const hasUrl = parts.some(p => /^https?:\/\//i.test(p));
  return hasUrl ? parts : [parts.join(' ')];
}
// ---- resolve (compat) ----
async function resolveOneCompat(node, q) {
  const search = /^https?:\/\//i.test(q) ? q : `ytsearch:${q}`;
  const res = await node.rest.resolve(search).catch(e => { console.error('[resolveOne]', e?.message || e); return null; });
  if (!res) return null;
  const tracks = res?.tracks || res?.data || [];
  const isPlaylist = (res?.type === 'PLAYLIST') || (res?.loadType === 'playlist');
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return isPlaylist ? tracks : tracks[0];
}

// ---- allowlist: invited to other guilds ----
client.on('guildCreate', guild => {
  if (ALLOW.length && !ALLOW.includes(guild.id)) {
    console.log(`[ALLOWLIST] not allowed guild ${guild.id} (${guild.name}) -> leaving`);
    guild.leave().catch(() => {});
  }
});
// ---- interactions ----
client.on('interactionCreate', async i => {
  try {
    if (!i.isChatInputCommand()) return;
    if (ALLOW.length && !ALLOW.includes(i.guildId)) {
      return i.reply({ content: 'このサーバでは利用許可がありません。', ephemeral: true });
    }
    const gid = i.guildId;

    if (i.commandName === 'totoro_play') {
      const channelId = getVoiceChannelId(i);
      if (!channelId) return i.reply({ content: '先にボイスチャンネルに参加してね！', ephemeral: true });
      const raw = i.options.getString('query', true);
      const queries = parseQueries(raw);
      if (queries.length === 0) return i.reply({ content: 'クエリが空っぽっぽい…', ephemeral: true });
      await i.deferReply();
      const node = shoukaku.nodes.get('main') ?? [...shoukaku.nodes.values()][0];
      await ensureConnectionV4(gid, channelId);

      let added = 0;
      for (const q of queries) {
        const r = await resolveOneCompat(node, q);
        if (!r) continue;
        const s = getState(gid);
        if (Array.isArray(r)) { r.forEach(t => s.queue.push(t)); added += r.length; }
        else { s.queue.push(r); added += 1; }
      }
      const s = getState(gid);
      if (!s.playing) await playNext(gid);
      return i.editReply({ content: added > 0 ? `${added}件キューに追加したよ！` : '追加できなかった…' });
    }

    if (i.commandName === 'totoro_skip') {
      const s = getState(gid);
      if (!s.conn) return i.reply({ content: '何も再生してないみたい。', ephemeral: true });
      if (s.loop === 'track') s.loop = 'off';
      await s.conn.stopTrack();
      return i.reply({ content: '⏭ スキップしたよ（単曲ループは解除）。' });
    }
    if (i.commandName === 'totoro_loop') {
      const s = getState(gid);
      if (!s.current) return i.reply({ content: '今は何も再生してないみたい。', ephemeral: true });
      s.loop = 'track';
      return i.reply({ content: '🔁 単曲ループを有効にしたよ。スキップすると解除されるよ。' });
    }

    if (i.commandName === 'totoro_loop_queue' || i.commandName === 'totoro_loop_pueue') {
      const s = getState(gid);
      s.loop = 'queue';
      return i.reply({ content: '🔁 キュー全体ループを有効にしたよ。' });
    }

    if (i.commandName === 'totoro_leave') {
      const s = getState(gid);
      try { await s.conn?.leaveChannel(); } catch {}
      s.conn = null; s.queue = []; s.current = null; s.playing = false; s.loop = 'off';
      return i.reply({ content: '👋 退出してキューをクリアしたよ。' });
    }
    if (i.commandName === 'totoro_queue') {
      const s = getState(gid);
      if (!s.current && s.queue.length === 0) return i.reply({ content: 'キューは空だよ！', ephemeral: true });
      const lines = [];
      if (s.current) lines.push(`**▶ 再生中:** ${s.current.info?.title || '(unknown)'}`);
      s.queue.slice(0, 10).forEach((t, idx) => lines.push(`${idx + 1}. ${t.info?.title || '(unknown)'}`));
      const embed = new EmbedBuilder().setTitle('Totoro Queue').setDescription(lines.join('\n'))
        .addFields({ name: 'Loop', value: s.loop, inline: true });
      return i.reply({ embeds: [embed] });
    }
  } catch (e) {
    console.error('[interaction] failed:', e);
    try {
      if (i.deferred) await i.editReply('エラーが起きたみたい…ログを見てみてね。');
      else await i.reply({ content: 'エラーが起きたみたい…', ephemeral: true });
    } catch {}
  }
});

client.login(DISCORD_TOKEN);

// debug logs (任意)
shoukaku.on('ready', name => console.log(`[Shoukaku] node ${name} ready`));
shoukaku.on('error', (name, error) => console.error(`[Shoukaku] node ${name} error`, error?.message || error));
shoukaku.on('close', (name, code, reason) => console.warn(`[Shoukaku] node ${name} closed`, code, reason?.toString?.()));
