// modules/chatter/index.js
import { normalLines as _normal, rareLines as _rare, ultraLines as _ultra } from "./messages.js";
import fs from "node:fs";
import path from "node:path";

function parseAllowedGuilds(str) {
  if (!str) return null;
  return str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// 3層（normal/rare/ultra）の “各アイテム重み” 抽選
function pickWeighted({ normal, rare, ultra, wn = 100, wr = 10, wu = 1 }) {
  const n = Array.isArray(normal) ? normal : [];
  const r = Array.isArray(rare)   ? rare   : [];
  const u = Array.isArray(ultra)  ? ultra  : [];

  const nWeight = wn * n.length;
  const rWeight = wr * r.length;
  const uWeight = wu * u.length;

  const total = nWeight + rWeight + uWeight;
  if (total <= 0) return "";

  let x = Math.random() * total;

  if (x < nWeight) {
    const idx = Math.floor(x / wn);
    return n[idx];
  }
  x -= nWeight;

  if (x < rWeight) {
    const idx = Math.floor(x / wr);
    return r[idx];
  }
  x -= rWeight;

  const idx = Math.floor(x / wu);
  return u[idx];
}

// ---- AI Chat config / persona ----
const DATA_DIR = path.resolve(process.cwd(), "data", "ai_chat");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PERSONA_PATH = path.join(DATA_DIR, "persona.txt");

function safeReadText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function toPositiveInt(value, fallback, min = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function parseAiChannelsEnv(str) {
  // 例: "guildId:channelId,guildId2:channelId2"
  if (!str) return null;
  const map = new Map();
  for (const part of str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)) {
    const [gid, cid] = part.split(":").map(s => s?.trim());
    if (gid && cid) map.set(gid, cid);
  }
  return map;
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadAiConfig() {
  // 優先: ENV > data/ai_chat/config.json
  const envMap = parseAiChannelsEnv(process.env.TOTORO_AI_CHANNELS);
  const dailyLimit = toPositiveInt(process.env.TOTORO_AI_DAILY_LIMIT ?? "200", 200);

  if (envMap) {
    return { channelMap: envMap, dailyLimit };
  }

  const j = safeReadJson(CONFIG_PATH);
  const channelMap = new Map();
  if (j?.guilds && typeof j.guilds === "object") {
    for (const [gid, v] of Object.entries(j.guilds)) {
      if (v?.channelId) channelMap.set(gid, String(v.channelId));
    }
  }
  return { channelMap, dailyLimit };
}

function loadPersonaText() {
  const t = safeReadText(PERSONA_PATH);
  if (t && t.trim()) return t.trim();

  // persona.txt が無い/空のときのデフォルト
  return [
    "あなたはDiscord bot『トトロbot』として日本語で会話します。",
    "口調はフランクで優しく、たまに (　◜ω◝　) を使います（多用しない）。",
    "返答は通常は短め。必要なときだけ最大10文程度まで詳しく答えます。",
    "相手を不快にさせる煽り・説教・攻撃はしない。",
    "@everyone/@here やメンションを自分から使わない。",
    "出力はセリフをそのまま返す。最初に『トトロbot:』のような話者名は付けない。"
  ].join("\n");
}

function jstDateKey() {
  // JST日付（YYYY-MM-DD）: JST=UTC+9なのでオフセット加算してISO日付を取る
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// 文章を指定文数に軽く丸める（暴走保険）
function capToSentences(text, maxSentences = 10) {
  const t = (text ?? "").trim();
  if (!t) return "";

  const n = toPositiveInt(maxSentences, 10, 1);

  // 日本語と英語の句点/終端をざっくり扱う
  const parts = t
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？!?])\s*/g)
    .map(s => s.trim())
    .filter(Boolean);

  if (parts.length <= n) return t;
  return parts.slice(0, n).join("");
}

async function callOpenAIText({
  apiKey,
  model,
  instructions,
  inputText,
  maxOutputTokens,
  reasoningEffort,
}) {
  const body = {
    model,
    instructions, // persona.txt の内容
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: inputText }],
      },
    ],
    max_output_tokens: maxOutputTokens,
  };

  // GPT-5系モデル用。noneなら無効化。
  if (/^gpt-5/i.test(model) && reasoningEffort && reasoningEffort !== "none") {
    body.reasoning = { effort: reasoningEffort };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status} ${res.statusText} ${JSON.stringify(json, null, 2)}`);
  }

  // 出力がmax_output_tokens等で途中終了した場合は、半端な文章をDiscordに出さない。
  if (json.status === "incomplete") {
    const reason = json.incomplete_details?.reason ?? "unknown";
    throw new Error(`OpenAI incomplete: ${reason} ${JSON.stringify(json.incomplete_details ?? {})}`);
  }

  // 出力テキスト取り出し（堅牢版）
  const out =
    (typeof json.output_text === "string" && json.output_text) ||
    (json.output ?? [])
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => (typeof c.text === "string" ? c.text : c.text?.value ?? ""))
      .join("");

  return (out || "").trim();
}

export function wireChatterHandlers(client) {
  const enabled = (process.env.TOTORO_CHATTER ?? "1") !== "0";
  if (!enabled) return;

  const allowGuilds = parseAllowedGuilds(process.env.ALLOW_GUILDS);

  // ランダム台詞のクールダウン（既存）
  const cooldownSec = toPositiveInt(process.env.TOTORO_CHATTER_COOLDOWN ?? "30", 30, 0);

  // 既定: 100:10:1
  const normalWeight = toPositiveInt(process.env.TOTORO_CHATTER_NORMAL_WEIGHT ?? "100", 100);
  const rareWeight   = toPositiveInt(process.env.TOTORO_CHATTER_RARE_WEIGHT   ?? "10", 10);
  const ultraWeight  = toPositiveInt(process.env.TOTORO_CHATTER_ULTRA_WEIGHT  ?? "1", 1);

  const normal = Array.isArray(_normal) ? _normal : [];
  const rare   = Array.isArray(_rare)   ? _rare   : [];
  const ultra  = Array.isArray(_ultra)  ? _ultra  : [];

  // ---- AI settings ----
  const aiApiKey = process.env.OPENAI_API_KEY ?? "";
  const aiModel = process.env.TOTORO_AI_MODEL ?? "gpt-5.4-mini";
  const aiWindowSec = toPositiveInt(process.env.TOTORO_AI_WINDOW_SEC ?? "600", 600); // 10分
  const aiMaxMsgs = toPositiveInt(process.env.TOTORO_AI_MAX_MESSAGES ?? "30", 30);
  const aiMaxOutputTokens = toPositiveInt(process.env.TOTORO_AI_MAX_OUTPUT_TOKENS ?? "900", 900);
  const aiCooldownSec = toPositiveInt(process.env.TOTORO_AI_COOLDOWN ?? "2", 2, 0); // 速さ優先
  const aiMaxInputChars = toPositiveInt(process.env.TOTORO_AI_MAX_INPUT_CHARS ?? "2000", 2000); // 長文コピペ保険
  const aiMaxMemoryChars = toPositiveInt(process.env.TOTORO_AI_MAX_MEMORY_CHARS ?? "1200", 1200);
  const aiMaxSentences = toPositiveInt(process.env.TOTORO_AI_MAX_SENTENCES ?? "10", 10);
  const aiReasoningEffort = String(process.env.TOTORO_AI_REASONING_EFFORT ?? "low").trim();

  ensureDataDir();
  let { channelMap: aiChannelMap, dailyLimit: aiDailyLimit } = loadAiConfig();
  let personaText = loadPersonaText();

  // ランダム返答用のCD
  const channelCooldown = new Map(); // channelId -> unix sec

  // AI返答用のCD（別枠）
  const aiChannelCooldown = new Map(); // channelId -> unix sec
  const aiChannelLock = new Set(); // channelId currently generating

  // 日次上限（ギルド単位）
  const dailyCount = new Map(); // guildId -> { dateKey, count }

  // AI用の短期記憶（AIチャンネルごと）
  // key = `${guildId}:${channelId}` -> [{ts, role, name, text}]
  const memory = new Map();

  function getDaily(gid) {
    const key = jstDateKey();
    const cur = dailyCount.get(gid);
    if (!cur || cur.dateKey !== key) {
      const next = { dateKey: key, count: 0 };
      dailyCount.set(gid, next);
      return next;
    }
    return cur;
  }

  function addMemory(gid, cid, role, name, text) {
    const k = `${gid}:${cid}`;
    const arr = memory.get(k) ?? [];
    const nowMs = Date.now();
    arr.push({ ts: nowMs, role, name, text });

    // 時間窓で削る
    const cutoff = nowMs - aiWindowSec * 1000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();

    // 件数上限
    while (arr.length > aiMaxMsgs) arr.shift();

    memory.set(k, arr);
  }

  function buildTranscript(gid, cid) {
    const k = `${gid}:${cid}`;
    const arr = memory.get(k) ?? [];
    // すでに窓管理しているが念のため
    const cutoff = Date.now() - aiWindowSec * 1000;
    const recent = arr.filter(x => x.ts >= cutoff).slice(-aiMaxMsgs);

    // ログは短く。名前付きで分かりやすく。
    return recent.map(x => {
      const who = x.role === "assistant" ? "トトロbot" : (x.name || "user");
      return `${who}: ${x.text}`;
    }).join("\n");
  }

  async function sendRandomLine(msg) {
    // ランダムは既存CD適用（今まで通りの挙動）
    const now = Math.floor(Date.now() / 1000);
    const until = channelCooldown.get(msg.channelId) ?? 0;
    if (now < until) return;

    const line = pickWeighted({
      normal, rare, ultra,
      wn: normalWeight, wr: rareWeight, wu: ultraWeight,
    });
    if (!line) return;

    await msg.channel.send({
      content: line,
      allowedMentions: { parse: [] }
    });

    channelCooldown.set(msg.channelId, now + cooldownSec);

    // AIチャンネルなら、bot発言も短期記憶に入れておく（会話感UP）
    const gid = msg.guild?.id;
    if (gid) {
      const aiCid = aiChannelMap.get(gid);
      if (aiCid && aiCid === msg.channelId) {
        addMemory(gid, msg.channelId, "assistant", "トトロbot", line);
      }
    }
  }

  client.on("messageCreate", async (msg) => {
    try {
      if (!msg.guild) return;
      if (msg.author?.bot) return;
      if (allowGuilds && !allowGuilds.includes(msg.guild.id)) return;
      if (msg.mentions?.everyone) return;

      const me = client.user;
      if (!me) return;

      // 本文に <@id> / <@!id> の“直接メンション”が含まれるときのみ反応（返信は無視）
      const content = msg.content ?? "";
      const directMentionRe = new RegExp(`(^|\\s)<@!?${me.id}>(\\s|$)`);
      const hasDirectMentionInContent = directMentionRe.test(content);
      if (!hasDirectMentionInContent) return;

      // メンションを除去した “実質本文”
      const stripped = content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
      const hasUserText = stripped.length > 0;

      const gid = msg.guild.id;
      const aiChannelId = aiChannelMap.get(gid) ?? null;

      // 仕様:
      // - AIチャンネル未設定: 何でもランダム
      // - AIチャンネル以外: 何でもランダム
      // - AIチャンネル: 内容なし→ランダム / 内容あり→AI（上限超えたらランダム）
      const isAiChannel = !!(aiChannelId && msg.channelId === aiChannelId);

      // AIチャンネルで会話文脈に入れたいので、ユーザー発言も短期記憶へ
      if (isAiChannel) {
        // 入力長が極端に長いときはメモリにも入れすぎない（保険）
        const memoText = stripped.slice(0, aiMaxMemoryChars);
        addMemory(gid, msg.channelId, "user", msg.author?.username ?? "user", memoText || "(メンションのみ)");
      }

      // AI使えない状況は全部ランダムへ
      if (!isAiChannel) {
        await sendRandomLine(msg);
        return;
      }

      // AIチャンネルでも「内容なし」はランダム
      if (!hasUserText) {
        await sendRandomLine(msg);
        return;
      }

      // APIキーが無いならランダムへ（安全）
      if (!aiApiKey) {
        await sendRandomLine(msg);
        return;
      }

      // 日次上限（ギルド単位）
      const d = getDaily(gid);
      if (d.count >= aiDailyLimit) {
        await sendRandomLine(msg);
        return;
      }

      // AIチャンネルCD
      const now = Math.floor(Date.now() / 1000);
      const until = aiChannelCooldown.get(msg.channelId) ?? 0;
      if (now < until) {
        // 速さ優先：CD中はランダムに逃がす
        await sendRandomLine(msg);
        return;
      }

      // 同時生成防止（連投で二重課金を避ける）
      if (aiChannelLock.has(msg.channelId)) {
        await sendRandomLine(msg);
        return;
      }

      // 入力長制限（長文コピペ対策）
      const userText = stripped.slice(0, aiMaxInputChars);

      aiChannelLock.add(msg.channelId);
      aiChannelCooldown.set(msg.channelId, now + aiCooldownSec);

      // 最新設定を反映したいなら、たまに再ロードもアリ（重くない）
      // ※毎回読むとI/O増えるので、必要なら「一定間隔で更新」などに。
      // ここでは手動反映のため、再起動で更新でもOK。
      const transcript = buildTranscript(gid, msg.channelId);
      const persona = personaText;

      const inputText =
        (transcript ? `以下は直近の会話ログです。\n${transcript}\n\n` : "") +
        `ユーザー: ${userText}\n` +
        `通常は短く、必要なときだけ最大${aiMaxSentences}文程度で返答して。`;

      let out = "";
      try {
        out = await callOpenAIText({
          apiKey: aiApiKey,
          model: aiModel,
          instructions: persona,
          inputText,
          maxOutputTokens: aiMaxOutputTokens,
          reasoningEffort: aiReasoningEffort,
        });
      } catch (e) {
        console.error("[ai_chat] OpenAI call failed:", e);
        await sendRandomLine(msg);
        return;
      } finally {
        aiChannelLock.delete(msg.channelId);
      }

      out = capToSentences(out, aiMaxSentences);
      if (!out) {
        await sendRandomLine(msg);
        return;
      }

      await msg.channel.send({
        content: out,
        allowedMentions: { parse: [] }
      });

      // 成功時のみ日次カウント加算（「AI呼んで返した」分）
      d.count++;

      // bot発言も短期記憶へ
      addMemory(gid, msg.channelId, "assistant", "トトロbot", out);

    } catch (err) {
      console.error("[chatter] error:", err);
    }
  });
}