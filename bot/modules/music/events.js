// modules/music/events.js
import { useGlue } from './glue.js';
import { getState } from './state.js';
import { playNext, scheduleIdle, leaveHardAndClear } from './service.js';
import { __setBind as setBindHook } from './lavalink.js';

const EMPTY_LEAVE_DEBOUNCE_MS = 3000;
const emptyTimers = new Map(); // gid -> timeout

// “今この瞬間” BotがVCに居るか（終端イベントとレース対策）
function isBotInVcNow(guild) {
  const me = guild.members.me;
  return !!me?.voice?.channelId;
}

// 自発的退出の判定は state 上のタイムスタンプを参照（service.js が設定）
function isSelfLeaveRecent(gid) {
  const s = getState(gid);
  const until = s.selfLeaveUntil || 0;
  return Date.now() < until ? 'command' : null;
}

export function attachMusicEventWires(client) {
  const { sendToChannel } = useGlue();

  // モジュールスコープで一意化：多重バインドによる通知連打を抑止
  const BOUND = new WeakSet();
  setBindHook((gid, player) => {
    if (!player || BOUND.has(player)) return;
    BOUND.add(player);
    const guild = client.guilds.cache.get(gid);

    // VCに「3分後に退出します」を出す共通関数（在室&自発退室ガード済み）
    const notifyIdleToVc = async (gidLocal, msg) => {
      if (!guild || !isBotInVcNow(guild)) return;
      const st = getState(gidLocal);
      if ((st.selfLeaveUntil || 0) > Date.now()) return;
      const vcId = guild.members.me?.voice?.channelId;
      if (!vcId) return;
      await sendToChannel(gidLocal, vcId, msg); // 送れなければ黙る
    };

    player.on('end', async () => {
      const st = getState(gid);
      if (!st.conn || !guild || !isBotInVcNow(guild)) return;
      if ((st.selfLeaveUntil || 0) > Date.now()) return;

      if (st.loop === 'track' && st.current) {
        await st.conn.playTrack({ track: { encoded: st.current.encoded } });
        return;
      }
      if (st.loop === 'queue' && st.current) st.queue.push(st.current);
      st.current = null; st.playing = false;

      await playNext(gid);
      const nothingLeft = !st.playing && st.queue.length === 0;
      if (nothingLeft && !st.idleTimer) {
        await notifyIdleToVc(gid, '⛳ 次に再生する曲はありません。3分後に退出します。');
        scheduleIdle(gid, 'end-empty');
      }
    });

    player.on('stuck', () => {
      const st = getState(gid);
      st.playing = false;
      if (!st.conn || !guild || !isBotInVcNow(guild)) return;
      if ((st.selfLeaveUntil || 0) > Date.now()) return;

      const nothingLeft = st.queue.length === 0;
      if (nothingLeft) {
        if (!st.idleTimer) {
          notifyIdleToVc(gid, '⚠️ 再生エラーのため停止。3分後に退出します。');
          scheduleIdle(gid, 'stuck');
        }
      } else {
        playNext(gid).catch(() => {});
      }
    });

    player.on('exception', () => {
      const st = getState(gid);
      st.playing = false;
      if (!st.conn || !guild || !isBotInVcNow(guild)) return;
      if ((st.selfLeaveUntil || 0) > Date.now()) return;

      const nothingLeft = st.queue.length === 0;
      if (nothingLeft) {
        if (!st.idleTimer) {
          notifyIdleToVc(gid, '⚠️ 例外により停止。3分後に退出します。');
          scheduleIdle(gid, 'exception');
        }
      } else {
        playNext(gid).catch(() => {});
      }
    });

    player.on('error', (e) => {
      console.error(`[PlayerError][${gid}]`, e);
      const st = getState(gid);
      st.playing = false;
      if (!st.conn || !guild || !isBotInVcNow(guild)) return;
      if ((st.selfLeaveUntil || 0) > Date.now()) return;

      const nothingLeft = st.queue.length === 0;
      if (nothingLeft) {
        if (!st.idleTimer) {
          notifyIdleToVc(gid, '⚠️ エラーにより停止。3分後に退出します。');
          scheduleIdle(gid, 'error');
        }
      }
    });
  });

  // === voiceStateUpdate: Bot関連のみ処理 & 空VC 3秒デバウンス ===
  client.on('voiceStateUpdate', async (oldS, newS) => {
    const guild = newS?.guild ?? oldS?.guild;
    if (!guild || !client.user) return;
    const gid = guild.id;

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const botChId = me?.voice?.channelId;

    // 在室中は lastVcId を常時更新（nullでは上書きしない）
    if (botChId) {
      const st = getState(gid);
      st.lastVcId = botChId;
    }

    // Botに関係ない出入りは無視
    const related =
      (oldS?.channelId && oldS.channelId === botChId) ||
      (newS?.channelId && newS.channelId === botChId) ||
      newS.id === client.user.id || oldS.id === client.user.id;
    if (!related) return;

    // 1) Botが切断された（oldにいて new にいない）
    if (newS.id === client.user.id && oldS?.channelId && !newS?.channelId) {
      // 自発退室なら抑止
      const selfReason = isSelfLeaveRecent(gid);
      if (selfReason) {
        console.log(`[voice] self-leave(${selfReason}) confirmed in ${gid}; state cleared already`);
        return;
      }

      // 退出前に送信先を確保：退出元VC or 直近在室VC
      const fromId = oldS?.channelId || getState(gid).lastVcId;

      // 方針：自分はもうVCにいない && lastVcId(=fromId)がある && 自主退室ではない → 強制扱いで通知
      await leaveHardAndClear(gid);

      if (fromId) {
        const ok = await sendToChannel(gid, fromId, '🔇 ボットは**強制的に退出**させられました。キューはクリアしました。');
        console.log(`[voice] forced-disconnect(policy): sent=${ok} gid=${gid} ch=${fromId}`);
      } else {
        console.log(`[voice] forced-disconnect(policy) but no fromId, gid=${gid}`);
      }
      return;
    }

    // 2) Botが部屋移動（old と new があり、かつ異なる）→ 常に強制扱い
    if (newS.id === client.user.id && oldS?.channelId && newS?.channelId && oldS.channelId !== newS.channelId) {
      const s = getState(gid);
      const fromId = oldS?.channelId || s.lastVcId;
      const toId = newS.channelId;

      await leaveHardAndClear(gid);

      if (fromId) {
        const ok = await sendToChannel(gid, fromId, '🔇 ボットは**強制的に移動**させられたため、退出しました。キューはクリアしました。');
        console.log(`[voice] forced-move(policy): sent=${ok} gid=${gid} from=${fromId} to=${toId}`);
      } else {
        console.log(`[voice] forced-move(policy) but no fromId, gid=${gid} to=${toId}`);
      }
      return;
    }

    // 3) 空VC検知（人間ゼロのみ）→3秒後に再確認の上で退出
    if (botChId) {
      const ch = guild.channels.cache.get(botChId);
      const humans = ch?.members?.filter(m => !m.user.bot)?.size ?? 0;

      clearTimeout(emptyTimers.get(gid));
      if (humans === 0) {
        const t = setTimeout(async () => {
          const nowMe = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
          const nowCh = nowMe?.voice?.channelId ? guild.channels.cache.get(nowMe.voice.channelId) : null;
          const nowHumans = nowCh?.members?.filter(m => !m.user.bot)?.size ?? 0;
          if (nowHumans === 0 && nowCh) {
            const leftFrom = nowCh.id;
            const st = getState(gid);
            st.selfLeaveUntil = Date.now() + 10000;
            await leaveHardAndClear(gid);
            console.log(`[voice] channel empty in ${gid}; left & cleared`);
            // VCに送れないなら黙る（フォールバックしない）
            const ok = await sendToChannel(gid, leftFrom, '誰もいなくなったから落ちるね...(´・ω・｀)');
            console.log(`[voice] notice(empty): sent=${ok} gid=${gid} ch=${leftFrom}`);
          }
        }, EMPTY_LEAVE_DEBOUNCE_MS);
        emptyTimers.set(gid, t);
      }
    }
  });
}
