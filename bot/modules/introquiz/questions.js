import fs from 'node:fs';
import path from 'node:path';

const QUESTIONS_PATH = path.resolve(process.cwd(), 'data/intro/questions.json');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const text = raw.replace(/^\uFEFF/, '').trim();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    console.error('[introquiz] questions.json の読み込みに失敗:', err);
    return {};
  }
}

export function loadIntroQuestions() {
  return readJsonSafe(QUESTIONS_PATH);
}

export function getIntroQuestion(no) {
  const all = loadIntroQuestions();
  return all[String(no)] ?? null;
}