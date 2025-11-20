// modules/music/utils.js

// Promiseベースのsleep
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ざっくりURL判定（プロトコル付きのみ）
const isUrl = (x) => /^https?:\/\//i.test(x || '');

// 不可視文字や全角スペースも含めて両端を整理
const cleanText = (s) =>
  String(s ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // ZWSP類を除去
    .trim();

// 失敗してもnullを返す安全URLパーサ
const safeURL = (input) => {
  try { return new URL(input); } catch { return null; }
};

// YouTube判定（サブドメイン含む）
const isYouTubeHost = (h) => {
  const host = (h || '').toLowerCase().replace(/^www\./, '');
  return host === 'youtu.be' || host.endsWith('youtube.com');
};

// 共有リンク由来の“余計”なパラメータは捨てる
// 単発: v だけ残す / プレイリスト併用: v と list（任意で index）を残す
const stripYouTubeParams = (urlObj) => {
  const keep = new URLSearchParams();
  const v = urlObj.searchParams.get('v');
  const list = urlObj.searchParams.get('list');
  const index = urlObj.searchParams.get('index'); // 任意
  if (v) keep.set('v', v);
  if (list) keep.set('list', list);
  if (index) keep.set('index', index);
  // t / start など開始位置は今回は未対応にする（必要ならここでkeepする）
  urlObj.search = keep.toString() ? `?${keep.toString()}` : '';
  urlObj.hash = ''; // #t= なども消す
  return urlObj;
};

/**
 * YouTube URL を watch?v=形式へ正規化し、余計なクエリを削除。
 * - youtu.be/<id>  → https://www.youtube.com/watch?v=<id>
 * - youtube.com/shorts/<id> → .../watch?v=<id>
 * - m./music. サブドメインも吸収
 * - watch?v= のときは v を保持し、プレイリスト併用なら list（任意で index）も保持
 * - 不要な共有系クエリ（si, pp, feature など）は削除
 */
export function normalizeYouTubeUrl(input) {
  const raw = cleanText(input);
  const u = safeURL(raw);
  if (!u) return input;

  if (!isYouTubeHost(u.hostname)) {
    // YouTube以外は触らない（Lavalink側に委ねる）
    return input;
  }

  const host = u.hostname.replace(/^www\./i, '').toLowerCase();

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (id) {
      const out = new URL('https://www.youtube.com/watch');
      out.searchParams.set('v', id);
      // もし元URLに list があれば引き継ぐ
      const list = u.searchParams.get('list');
      const index = u.searchParams.get('index');
      if (list) out.searchParams.set('list', list);
      if (index) out.searchParams.set('index', index);
      return stripYouTubeParams(out).toString();
    }
    return input;
  }

  // *.youtube.com
  const path = u.pathname || '/';

  // /shorts/<id>
  if (/^\/shorts\//i.test(path)) {
    const id = path.split('/')[2] || '';
    if (id) {
      const out = new URL('https://www.youtube.com/watch');
      out.searchParams.set('v', id);
      const list = u.searchParams.get('list');
      const index = u.searchParams.get('index');
      if (list) out.searchParams.set('list', list);
      if (index) out.searchParams.set('index', index);
      return stripYouTubeParams(out).toString();
    }
    return input;
  }

  // /watch?v=...
  if (path === '/watch' && (u.searchParams.has('v') || u.searchParams.has('list'))) {
    return stripYouTubeParams(u).toString();
  }

  // /playlist?list=...
  if (path === '/playlist' && u.searchParams.has('list')) {
    const out = new URL('https://www.youtube.com/playlist');
    out.searchParams.set('list', u.searchParams.get('list'));
    // index 等は playlist では通常不要、明示的に落とす
    return out.toString();
  }

  // /embed/<id> → watch?v=
  if (/^\/embed\//i.test(path)) {
    const id = path.split('/')[2] || '';
    if (id) {
      const out = new URL('https://www.youtube.com/watch');
      out.searchParams.set('v', id);
      const list = u.searchParams.get('list');
      const index = u.searchParams.get('index');
      if (list) out.searchParams.set('list', list);
      if (index) out.searchParams.set('index', index);
      return stripYouTubeParams(out).toString();
    }
    return input;
  }

  // /v/<id>（古い形式）→ watch?v=
  if (/^\/v\//i.test(path)) {
    const id = path.split('/')[2] || '';
    if (id) {
      const out = new URL('https://www.youtube.com/watch');
      out.searchParams.set('v', id);
      const list = u.searchParams.get('list');
      const index = u.searchParams.get('index');
      if (list) out.searchParams.set('list', list);
      if (index) out.searchParams.set('index', index);
      return stripYouTubeParams(out).toString();
    }
    return input;
  }

  // playlist等その他のパスは変更しない（単発運用なのでresolve側で先頭のみ扱う）
  return input;
}

// 入力がURLならそのまま or YouTube URLを正規化、URLでなければ ytsearch:
export const buildIdentifier = (raw) => {
  const text = cleanText(raw);
  if (!text) return 'ytsearch:'; // 空なら空検索を回避
  if (isUrl(text)) return normalizeYouTubeUrl(text);
  return `ytsearch:${text}`;
};

// 単体/配列のゆれを配列化
export const toArray = (d) => (Array.isArray(d) ? d : (d ? [d] : []));
