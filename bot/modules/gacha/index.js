// modules/gacha/index.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} from 'discord.js';

import fs from 'node:fs';
import path from 'node:path';

// ====== Pickup倍率（コラボUR枚数ごと） ======
// 6枚コラボ: とある
const PICKUP_MULTI_6 = 21;

// 5枚コラボ: 初音ミク, ダンまち
const PICKUP_MULTI_5 = 21;

// 4枚コラボ: リゼロ, このすば, 文スト, SAO, Fate, チェンソーマン, ハンター
const PICKUP_MULTI_4 = 21;

// 3枚コラボ: 上記以外すべて
const PICKUP_MULTI_3 = 28;

// ギルギアの属性ピック倍率（赤/青/緑のうち1色だけ2倍）
const ATTRIBUTE_PICKUP = 2;


// ※ 値を変えたいときは↑の数字だけ書き換えればOK。

// ====== 設定系 ==================================================

// カードデータファイルのパス
const CARD_FILE = path.resolve(process.cwd(), 'data', 'gacha', 'cards.json');

// コラボ一覧（表示名と内部ID）
// ※「略称」をそのまま表示に使う。IDはカスタムID用のASCIIスラグ。
const COLLAB_LIST = [
  { key: 'ポプテピ', id: 'collab-poptepi' },
  { key: '影実', id: 'collab-kagejitsu' },
  { key: 'ハンター', id: 'collab-hunter' },
  { key: 'ボンドルド', id: 'collab-bondrewd' },
  { key: '幼女戦記', id: 'collab-youjo' },
  { key: 'チェンソーマン', id: 'collab-chainsaw' },
  { key: 'ロックマン', id: 'collab-rockman' },
  { key: '無職転生', id: 'collab-mushoku' },
  { key: 'とある', id: 'collab-toaru' },
  { key: '転スラ', id: 'collab-tensura' },
  { key: 'NieR', id: 'collab-nier' },
  { key: 'SAO', id: 'collab-sao' },
  { key: 'オバロ', id: 'collab-overlord' },
  { key: 'ペルソナ', id: 'collab-persona' },
  { key: 'ライザ', id: 'collab-ryza' },
  { key: '文スト', id: 'collab-bunsuto' },
  { key: 'FF', id: 'collab-ff' },
  { key: 'ダンまち', id: 'collab-danmachi' },
  { key: '超歌舞伎', id: 'collab-chokabuki' },
  { key: 'Fate', id: 'collab-fate' },
  { key: 'シュタゲ', id: 'collab-shutage' },
  { key: '猫宮', id: 'collab-nekomiya' },
  { key: '進撃', id: 'collab-shingeki' },
  { key: 'このすば', id: 'collab-konosuba' },
  { key: 'ダンロン', id: 'collab-danron' },
  { key: '殺天', id: 'collab-satsuten' },
  { key: 'リゼロ', id: 'collab-rezero' },
  { key: 'ストファイ', id: 'collab-sf' },
  { key: '初音ミク', id: 'collab-miku' },
  {
    key: 'ギルギア（赤ピック）',
    id: 'collab-guilgear-red',
    collabKey: 'ギルギア',
    variant: 'red'
  },
  {
    key: 'ギルギア（青ピック）',
    id: 'collab-guilgear-blue',
    collabKey: 'ギルギア',
    variant: 'blue'
  },
  {
    key: 'ギルギア（緑ピック）',
    id: 'collab-guilgear-green',
    collabKey: 'ギルギア',
    variant: 'green'
  }
];

// ===== 枚数ごとのグループ定義 =====
// 6枚: とある
const GROUP_6 = new Set(['とある']);

// 5枚: 初音ミク, ダンまち
const GROUP_5 = new Set(['初音ミク', 'ダンまち']);

// 4枚: リゼロ, このすば, 文スト, SAO, Fate, チェンソーマン, ハンター
const GROUP_4 = new Set([
  'リゼロ',
  'このすば',
  '文スト',
  'SAO',
  'Fate',
  'チェンソーマン',
  'ハンター'
]);

// それ以外は 3枚グループ扱い（Set は不要）

// コラボ名から、どの枚数グループかを見て倍率を返す
function getPickupMultiplier(collabName) {
  if (GROUP_6.has(collabName)) return PICKUP_MULTI_6;
  if (GROUP_5.has(collabName)) return PICKUP_MULTI_5;
  if (GROUP_4.has(collabName)) return PICKUP_MULTI_4;
  return PICKUP_MULTI_3; // その他は3枚グループ
}

// コラボごとの UR/SR 排出確率（ここは今まで通り個別調整用）
// ※ urRate/srRate を変えたいコラボだけ書き換えればOK。
//   未指定の項目は urRate=0.02, srRate=0.18, allowBaseUr=true として扱う。
const COLLAB_CONFIG = {
  'ポプテピ': { urRate: 0.02, srRate: 0.18 },
  '影実':     { urRate: 0.02, srRate: 0.18 },
  'ハンター': { urRate: 0.02, srRate: 0.18 },
  'ボンドルド': { urRate: 0.02, srRate: 0.18 },
  '幼女戦記': { urRate: 0.02, srRate: 0.18 },
  'チェンソーマン': { urRate: 0.02, srRate: 0.18 },
  'ロックマン': { urRate: 0.02, srRate: 0.18 },
  '無職転生': { urRate: 0.02, srRate: 0.18 },
  'とある': { urRate: 0.02, srRate: 0.18 },
  '転スラ': { urRate: 0.02, srRate: 0.18 },
  'NieR': { urRate: 0.02, srRate: 0.18 },
  'SAO': { urRate: 0.02, srRate: 0.18 },
  'オバロ': { urRate: 0.02, srRate: 0.18 },
  'ペルソナ': { urRate: 0.02, srRate: 0.18 },
  'ライザ': { urRate: 0.02, srRate: 0.18 },
  '文スト': { urRate: 0.02, srRate: 0.18 },
  'FF': { urRate: 0.02, srRate: 0.18 },
  'ダンまち': { urRate: 0.02, srRate: 0.18 },
  '超歌舞伎': { urRate: 0.02, srRate: 0.18 },
  'Fate': { urRate: 0.02, srRate: 0.18 },
  'シュタゲ': { urRate: 0.02, srRate: 0.18 },
  '猫宮': { urRate: 0.02, srRate: 0.18 },
  '進撃': { urRate: 0.02, srRate: 0.18 },
  'このすば': { urRate: 0.02, srRate: 0.18 },
  'ダンロン': { urRate: 0.02, srRate: 0.18 },
  '殺天': { urRate: 0.02, srRate: 0.18 },
  'リゼロ': { urRate: 0.02, srRate: 0.18 },
  'ストファイ': { urRate: 0.02, srRate: 0.18 },
  '初音ミク': { urRate: 0.02, srRate: 0.18 },
  // ギルギアは「恒常URが排出されない」特殊コラボ
  'ギルギア': { urRate: 0.02, srRate: 0.18, allowBaseUr: false }
};

// 恒常ガチャ定義（UR2%固定）
const BASE_GACHA = {
  id: 'perm-2',
  label: '恒常UR2%ガチャ',
  collabKey: null,
  urRate: 0.02,
  srRate: 0.18,
  allowBaseUr: true,
  urPickup: 1,
  srPickup: 1
};

// 全ガチャ定義をまとめておく
const GACHA_TYPES = [
  BASE_GACHA,
  ...COLLAB_LIST.map(entry => {
    const collabKey = entry.collabKey ?? entry.key; // ギルギア系だけ collabKey が別名
    const conf = COLLAB_CONFIG[collabKey] ?? {};

    const allowBaseUr =
      conf.allowBaseUr !== undefined
        ? conf.allowBaseUr
        : (collabKey === 'ギルギア' ? false : true);

    const pickup = getPickupMultiplier(collabKey);

    return {
      id: entry.id,
      // ギルギアは key にフルラベルが入っているので、そのまま使う
      // それ以外は「◯◯コラボガチャ」でも「◯◯」でも好きにしてOK
      label: entry.key,
      collabKey,
      urRate: conf.urRate ?? 0.02,
      srRate: conf.srRate ?? 0.18,
      allowBaseUr,
      urPickup: pickup,
      srPickup: pickup,
      // ギルギア用: 'red' / 'blue' / 'green' が入る（他は undefined）
      variant: entry.variant
    };
  })
];


function findGachaById(id) {
  return GACHA_TYPES.find(g => g.id === id) ?? null;
}

// ====== データ読み込み ==========================================

function loadCardData() {
  try {
    const text = fs.readFileSync(CARD_FILE, 'utf8');
    const json = JSON.parse(text);
    return json;
  } catch (err) {
    return null;
  }
}

// ====== 抽選ロジック ============================================

// レアリティの抽選（UR / SR / R）
function rollRarity(urRate, srRate) {
  const r = Math.random();
  if (r < urRate) return 'UR';
  if (r < urRate + srRate) return 'SR';
  return 'R';
}

// URの1枚を重み付きで抽選
function rollUrCard(gacha, cards) {
  const baseUr = cards.base?.ur ?? [];
  const items = [];

  // 恒常UR
  if (gacha.allowBaseUr) {
    for (const name of baseUr) {
      items.push({ name, weight: 1, isCollab: false });
    }
  }

  // コラボUR
  if (gacha.collabKey) {
    // ▼ ギルギアだけ「赤/青/緑」を分けて属性ピック
    if (gacha.collabKey === 'ギルギア') {
      const urGroups = cards.collabs?.['ギルギア']?.ur ?? {};
      const fav = gacha.variant ?? null;          // 'red' / 'blue' / 'green'
      const colors = ['red', 'blue', 'green'];
      const pickup = gacha.urPickup ?? 1;         // コラボ全体倍率

      for (const color of colors) {
        const names = urGroups[color] ?? [];
        const colorMul = fav && color === fav ? ATTRIBUTE_PICKUP : 1; // ★ ここで2倍

        for (const name of names) {
          items.push({
            name,
            weight: pickup * colorMul,
            isCollab: true
          });
        }
      }
    } else {
      // ▼ 通常コラボ（今まで通り）
      const collabUr = cards.collabs?.[gacha.collabKey]?.ur ?? [];
      const pickup = gacha.urPickup ?? 1;
      for (const name of collabUr) {
        items.push({ name, weight: pickup, isCollab: true });
      }
    }
  }

  if (items.length === 0) return null;

  const totalWeight = items.reduce((sum, it) => sum + it.weight, 0);
  let r = Math.random() * totalWeight;

  for (const it of items) {
    if (r < it.weight) return it;
    r -= it.weight;
  }
  return items[items.length - 1];
}

// SRの1枚を重み付きで抽選（ただし恒常SRのカード名は不要なので、
// 「コラボSRかどうか」と「コラボSRなら名前」を返すだけ）
function rollSrCard(gacha, cards) {
  const srCountBase = cards.base?.srCount ?? 0;
  const baseWeight = srCountBase; // 恒常SRは1枚=重み1 扱い

  let collabEntries = [];

  if (gacha.collabKey) {
    if (gacha.collabKey === 'ギルギア') {
      // ▼ ギルギアSR: 属性ごとに倍率2倍
      const srGroups = cards.collabs?.['ギルギア']?.sr ?? {};
      const fav = gacha.variant ?? null; // 'red' / 'blue' / 'green'
      const colors = ['red', 'blue', 'green'];
      const pickup = gacha.srPickup ?? 1;

      for (const color of colors) {
        const names = srGroups[color] ?? [];
        const colorMul = fav && color === fav ? ATTRIBUTE_PICKUP : 1;

        for (const name of names) {
          collabEntries.push({
            name,
            weight: pickup * colorMul
          });
        }
      }
    } else {
      // ▼ 通常コラボSR（今まで通り）
      const collabSrArr = cards.collabs?.[gacha.collabKey]?.sr ?? [];
      const pickup = gacha.srPickup ?? 1;
      collabEntries = collabSrArr.map(name => ({
        name,
        weight: pickup
      }));
    }
  }

  const collabWeightTotal = collabEntries.reduce((s, e) => s + e.weight, 0);
  const totalWeight = baseWeight + collabWeightTotal;
  if (totalWeight <= 0) {
    return { isCollab: false, name: null };
  }

  let r = Math.random() * totalWeight;

  // まず「コラボSRを引いたかどうか」
  if (r < collabWeightTotal && collabEntries.length > 0) {
    let t = r;
    for (const e of collabEntries) {
      if (t < e.weight) {
        return { isCollab: true, name: e.name };
      }
      t -= e.weight;
    }
    // 浮動小数の誤差用フォールバック
    const last = collabEntries[collabEntries.length - 1];
    return { isCollab: true, name: last.name };
  }

  // 恒常SR（名前は表示しない）
  return { isCollab: false, name: null };
}

// まとめてガチャを回す
function simulateGacha(gacha, cards, times) {
  const result = {
    collabUr: [],
    baseUr: [],
    collabSr: []
  };

  for (let i = 0; i < times; i++) {
    const rarity = rollRarity(gacha.urRate, gacha.srRate);

    if (rarity === 'UR') {
      const picked = rollUrCard(gacha, cards);
      if (!picked || !picked.name) continue;

      if (picked.isCollab) {
        result.collabUr.push(picked.name);
      } else {
        result.baseUr.push(picked.name);
      }
    } else if (rarity === 'SR') {
      const picked = rollSrCard(gacha, cards);
      if (picked.isCollab && picked.name) {
        result.collabSr.push(picked.name);
      }
      // 恒常SRはカウントも表示もいらない
    } else {
      // Rは何も記録しない
    }
  }

  return result;
}

// ====== 表示用ヘルパ ============================================

function groupByName(list) {
  const map = new Map();
  for (const name of list) {
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
}

function formatCardList(list) {
  if (!list.length) return 'なし';
  const grouped = groupByName(list);
  return grouped
    .map(g => `• ${g.name} ×${g.count}`)
    .join('\n');
}

function buildResultEmbed(gacha, times, result) {
  const totalUr = result.collabUr.length + result.baseUr.length;
  const totalSrCollab = result.collabSr.length;

  const embed = new EmbedBuilder()
    .setTitle(`トトロガチャシミュレータ：${gacha.label}`)
    .setDescription(
      [
        `実行回数: **${times}連**`,
        '',
        `UR合計: **${totalUr}枚** (コラボUR: ${result.collabUr.length} / 恒常UR: ${result.baseUr.length})`,
        `SR合計: （コラボSR: ${totalSrCollab}枚 / 恒常SR: 表示なし）`
      ].join('\n')
    )
    .setTimestamp(new Date());

  embed.addFields(
    {
      name: 'コラボUR',
      value: formatCardList(result.collabUr)
    },
    {
      name: '恒常UR',
      value: formatCardList(result.baseUr)
    },
    {
      name: 'コラボSR',
      value: formatCardList(result.collabSr)
    }
  );

  return embed;
}

// ====== コンポーネント生成 ======================================

// ガチャ選択UI
function buildGachaSelectComponents() {
  // 恒常ガチャボタン
  const baseRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('gacha:sel:perm-2')
      .setLabel('恒常UR2%ガチャ')
      .setStyle(ButtonStyle.Primary)
  );

  // コラボを2つのセレクトメニューに分割する（1〜15 / 16〜30）
  const firstHalf = COLLAB_LIST.slice(0, 15);
  const secondHalf = COLLAB_LIST.slice(15);

  const collabSelect1 = new StringSelectMenuBuilder()
    .setCustomId('gacha:collab:1')
    .setPlaceholder('コラボガチャを選択 (1/2)')
    .addOptions(
      firstHalf.map(entry => ({
        label: entry.key,
        value: entry.id
      }))
    );

  const collabSelect2 = new StringSelectMenuBuilder()
    .setCustomId('gacha:collab:2')
    .setPlaceholder('コラボガチャを選択 (2/2)')
    .addOptions(
      secondHalf.map(entry => ({
        label: entry.key,
        value: entry.id
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(collabSelect1);
  const row2 = new ActionRowBuilder().addComponents(collabSelect2);

  return [baseRow, row1, row2];
}

// 連数選択ボタン
function buildRollCountButtons(gachaId) {
  // 候補を好きなだけ増やしてOK（ここだけいじればいい）
  const counts = [1, 60, 300, 800, 2400, 100000];

  const rows = [];
  const chunkSize = 5; // 1行あたり最大5ボタン

  for (let i = 0; i < counts.length; i += chunkSize) {
    const slice = counts.slice(i, i + chunkSize);

    const row = new ActionRowBuilder().addComponents(
      slice.map(c =>
        new ButtonBuilder()
          .setCustomId(`gacha:roll:${gachaId}:${c}`)
          .setLabel(`${c}連`)
          .setStyle(ButtonStyle.Secondary)
      )
    );

    rows.push(row);
  }

  return rows;
}


// ====== スラッシュコマンド公開API ===============================

export function buildGachaCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('totoro_gacha')
    .setDescription('コンパスガチャシミュレータ');
  return [cmd];
}

// /totoro_gacha の本体
export async function handleGachaSlash(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'totoro_gacha') return false;

  const components = buildGachaSelectComponents();

  await interaction.reply({
    content: 'どのガチャを回しますか？',
    components
    // ← ephemral: true を付けない = 公開メッセージ
  });

  return true;
}

// ====== ボタン / セレクトのディスパッチ ==========================

export async function dispatchGachaInteraction(interaction) {
  // ボタン
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'gacha') return false;

    const type = parts[1];

    if (type === 'sel') {
      // ガチャ選択ボタン（恒常）
      const gachaId = parts[2];
      return handleGachaChosen(interaction, gachaId);
    }

    if (type === 'roll') {
      const gachaId = parts[2];
      const count = Number(parts[3]) || 1;
      return handleRoll(interaction, gachaId, count);
    }

    return false;
  }

  // セレクトメニュー（コラボ選択）
  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'gacha') return false;
    if (parts[1] !== 'collab') return false;

    const gachaId = interaction.values[0];
    return handleGachaChosen(interaction, gachaId);
  }

  return false;
}

// ガチャが選ばれた後、「何連回すか？」に画面を更新
async function handleGachaChosen(interaction, gachaId) {
  const gacha = findGachaById(gachaId);
  if (!gacha) {
    await interaction.update({
      content: '内部エラー：不明なガチャIDです。',
      components: []
    });
    return true;
  }

  const rows = buildRollCountButtons(gachaId);

  await interaction.update({
    content: `ガチャ: **${gacha.label}**\n何連回しますか？`,
    components: rows
  });

  return true;
}

async function handleRoll(interaction, gachaId, count) {
  const gacha = findGachaById(gachaId);
  if (!gacha) {
    await interaction.update({
      content: '内部エラー：不明なガチャIDです。',
      components: [],
      embeds: []
    });
    return true;
  }

  const cards = loadCardData();
  if (!cards) {
    await interaction.update({
      content: 'カードデータ (data/gacha/cards.json) を読み込めませんでした。',
      components: [],
      embeds: []
    });
    return true;
  }

  const result = simulateGacha(gacha, cards, count);
  const embed = buildResultEmbed(gacha, count, result);

    await interaction.update({
    content: '',           // ここは完全に空でOK（または '\u200B' とかでも可）
    embeds: [embed],
    components: []         // ボタンは片付ける
  });


  return true;
}
