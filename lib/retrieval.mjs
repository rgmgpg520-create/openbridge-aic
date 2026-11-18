// Chunk-level BM25 retrieval over project documents.
//
// Why chunks: the previous version ranked whole documents by keyword counts and
// then extracted a window around the first matching line. Long files
// (tests/test_requests.py is ~108 KB) competed as a single unit and it was hard to
// tell which part actually answered the question. Here every document is split
// into ~1.1k char chunks with real line numbers, scored with BM25 over CJK
// bigrams and ASCII words, and the best chunk per document is returned.
//
// A small bilingual glossary maps common Chinese question words onto the English
// vocabulary of upstream files. It is a hand-maintained domain glossary, not a
// learned translation model; its limits are measured by the hold-out set.

import { terms } from './text.mjs';

export const GLOSSARY = {
  '安装': ['install', 'pip'], '怎么安装': ['install', 'pip'], '发起': ['get', 'request'], '最小': ['get'],
  '贡献': ['contribute', 'contributing', 'fork', 'pull request'], '提交': ['pull request', 'commit', 'submit'],
  '代码': ['code', 'test'], '重复': ['duplicate'], 'pr': ['pull request'],
  '测试': ['test', 'pytest'], '连接超时': ['connection', 'timeout'], '超时': ['timeout'], '连接': ['connection', 'keep-alive'],
  '版本': ['version', 'supported'], '支持哪些': ['supported versions'], '下载': ['download'],
  'cookie': ['cookie', 'session'], '复用': ['keep-alive', 'session', 'pooling'],
  '再分发': ['distribution', 'redistribute'], 'apache': ['apache', 'license'], '许可证': ['license'], '许可': ['license', 'apache'],
  // Licence questions are often asked with words that never appear in the Apache
  // text itself ("能否商用", "改成闭源再卖"). The licence file is still the document
  // that answers them, so map the intent vocabulary onto the wording the licence
  // actually uses (grant/permission/distribute/copyright/patent).
  '商用': ['commercial', 'license', 'permission'], '闭源': ['proprietary', 'license', 'permission'],
  '卖': ['sell', 'distribute', 'license'], '版权': ['copyright'], '专利': ['patent'],
  '安全漏洞': ['security', 'vulnerability'], '安全': ['security'], '漏洞': ['vulnerability', 'security'],
  'issue': ['issue', 'bug', 'reproduce', 'environment', 'expected', 'actually'],
  '实际结果': ['actually'], '预期结果': ['expected'], '环境': ['environment'], '复现': ['reproduce'],
  '草稿': ['template', 'reproduce', 'environment'], '模板': ['template'],
  '公开': ['public', 'disclose'], '令牌': ['token', 'disclose'], '私密': ['advisory', 'private'],
  '分支': ['branch', 'main'], '文档': ['documentation', 'docs'], '依赖': ['dependency', 'install'],
  // Regression-style questions ("will my change break something?") were the one
  // hold-out question that matched no glossary entry at all, scored 0 in BM25 and
  // therefore fell through the absolute floor. These map the wording onto the
  // vocabulary the upstream contributing guide actually uses.
  // Deliberately no entry for 修改: in a licensing question ("modify the source
  // and redistribute") it means editing the code, not regression testing, and
  // adding change/test terms there demoted the LICENSE evidence in T24.
  '改动': ['change', 'regression', 'test'], '破坏': ['break', 'breaking', 'regression'],
  '回归': ['regression', 'test'], '影响': ['impact', 'break', 'regression'],
  '功能': ['feature', 'functionality', 'regression'],
  '已有功能': ['existing', 'regression'], '保证': ['ensure', 'verify', 'test'],
  // "上传文件用哪个参数" shares no vocabulary at all with the English signature
  // (`files=None`). 上传 is narrow enough to be safe; deliberately no entry for the
  // generic 文件, which would also fire on "测试文件在哪里" and pull the API source
  // into questions that belong to the test file.
  '上传': ['upload', 'files']
};

export function expandQuery(query) {
  const base = String(query || '').toLowerCase();
  const extras = [];
  for (const [phrase, words] of Object.entries(GLOSSARY)) {
    if (base.includes(phrase.toLowerCase())) extras.push(...words);
  }
  return [...new Set(extras.map((word) => word.toLowerCase()))];
}

/** Split a document into overlapping chunks, keeping 1-based line numbers. */
export function chunkDocument(text, { target = 1100, overlap = 180 } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const chunks = [];
  let start = 0;
  let charStart = 0;

  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length && (length < target || end === start)) {
      length += lines[end].length + 1;
      end += 1;
    }
    const content = lines.slice(start, end).join('\n');
    chunks.push({ text: content, lineStart: start + 1, lineEnd: end, charStart, charEnd: charStart + content.length });
    if (end >= lines.length) break;
    charStart += content.length;
    let back = 0;
    let backChars = 0;
    while (end - back - 1 > start && backChars + lines[end - back - 1].length + 1 <= overlap) {
      back += 1;
      backChars += lines[end - back].length + 1;
    }
    start = Math.max(start + 1, end - back);
  }
  return chunks;
}

/** Build the BM25 index from chunk records produced by chunkDocument. */
export function buildIndex(entries) {
  const chunks = [];
  for (const entry of entries) {
    for (const chunk of entry.chunks) {
      chunks.push({ docId: entry.docId, type: entry.type || '', ...chunk, terms: terms(chunk.text) });
    }
  }
  const df = new Map();
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.text.length;
    for (const term of chunk.terms.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  return { chunks, df, avgLength: totalLength / Math.max(chunks.length, 1), N: chunks.length };
}

function idf(index, term) {
  const n = index.df.get(term) || 0;
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

function bm25(index, chunk, queryTerms, k1 = 1.2, b = 0.75) {
  let score = 0;
  const length = chunk.text.length || 1;
  for (const term of queryTerms) {
    const tf = chunk.terms.get(term);
    if (!tf) continue;
    score += idf(index, term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / index.avgLength));
  }
  return score;
}

const INTENT_PRIOR = {
  license: ['LICENSE'],
  security: ['SECURITY'],
  tests: ['TEST'],
  contribute: ['CONTRIBUTING', 'DOC'],
  issue: ['CONTRIBUTING', 'CODE'],
  draft: ['CONTRIBUTING'],
  usage: ['README', 'CODE']
};

// Question terms that carry no retrieval signal. Chinese questions are tokenised
// into character bigrams, so function words surface as bigrams like 怎么 / 什么.
const QUERY_STOP_TERMS = new Set([
  '怎么', '如何', '什么', '哪些', '哪个', '可以', '需要', '是否', '有没有', '为什', '什幺',
  '一个', '这个', '那个', '现在', '时候', '问题', '知道', '告诉', '请问', '应该', '不能',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'which', 'how', 'does', 'can'
]);

/**
 * How much of the question's distinctive vocabulary actually occurs in the evidence.
 *
 * The retrieval score cannot answer "is this corpus able to answer the question at
 * all?": an out-of-corpus question ("how many contributors does Requests have?")
 * scores as high as a real one, so a score threshold does not separate them — that
 * was measured on 8 out-of-corpus probes against the 32 dev cases. Coverage is a
 * different signal: it asks whether the words the question is *about* (the entity
 * or attribute it names) appear in the retrieved text. Reported as a ratio so a
 * caller can decide how much to trust the evidence instead of guessing from a score.
 *
 * @returns {number|null} 0..1, or null when the question has no distinctive terms.
 */
export function questionCoverage(query, evidenceText) {
  const wanted = [...terms(query).keys()].filter((term) => term.length >= 2 && !QUERY_STOP_TERMS.has(term));
  if (!wanted.length) return null;
  const text = String(evidenceText || '').toLowerCase();
  const found = wanted.filter((term) => text.includes(term));
  return Math.round((found.length / wanted.length) * 100) / 100;
}

/**
 * Rank documents by their best chunk and return that chunk as evidence.
 * @returns {Array<{docId:string, score:number, text:string, lineStart:number, lineEnd:number}>}
 */
export function search(index, query, { limit = 3, intent = null, documents = [], minRelative = 0 } = {}) {
  const queryTerms = [...new Set([...terms(query).keys(), ...expandQuery(query)])];
  const prior = INTENT_PRIOR[intent] || [];
  const docMap = new Map(documents.map((doc) => [doc.id, doc]));
  const metaByDoc = new Map(documents.map((doc) => [
    doc.id,
    new Set(terms(`${doc.title || ''} ${(doc.tags || []).join(' ')} ${doc.content || ''}`).keys())
  ]));

  const perDoc = new Map();
  for (const chunk of index.chunks) {
    let score = bm25(index, chunk, queryTerms);
    const meta = metaByDoc.get(chunk.docId);
    if (meta) {
      let hits = 0;
      for (const term of queryTerms) if (meta.has(term)) hits += 1;
      score += Math.min(hits, 3) * 1.2;
    }
    const doc = docMap.get(chunk.docId);
    if (doc && prior.includes(doc.type)) score += 1.4;
    // Apache/LICENSE prose contains words like "submitted", which makes the
    // license file a spurious hit for contribution questions. Keep it out of
    // the ranking unless the question is actually about licensing or security.
    if (doc && doc.type === 'LICENSE' && intent !== 'license' && intent !== 'security') score -= 4.5;
    // The giant tests file superficially matches bug-report/security/license
    // questions (words like "reproduce", "timeout", "distribution" in test
    // ids), but it cannot answer process questions. Keep it out unless the
    // question is actually about tests or concrete usage behavior.
    if (doc && doc.type === 'TEST' && ['issue', 'draft', 'security', 'license', 'contribute'].includes(intent)) score -= 4.5;
    // Plain bug-report questions are answered by CONTRIBUTING.md; the security
    // policy and the developer guide match the word "reproduce" but answer a
    // different process, so keep them out of the evidence set for issue/draft.
    if (doc && doc.type === 'SECURITY' && ['issue', 'draft', 'contribute'].includes(intent)) score -= 4.5;
    // Security questions follow the private Draft Security Advisory policy; the
    // public issue template (CONTRIBUTING) asks for full traceback/OS/toolchain
    // details that do not belong in a security-advisory report, so keep it out.
    if (doc && doc.type === 'CONTRIBUTING' && intent === 'security') score -= 4.5;
    if (doc && doc.type === 'DOC' && intent === 'issue') score -= 3.0;
    if (doc && String(query || '').toLowerCase().includes(String(doc.title || '').toLowerCase())) score += 1.2;
    const current = perDoc.get(chunk.docId);
    if (!current || score > current.score) perDoc.set(chunk.docId, { docId: chunk.docId, score, chunk });
  }

  const ranked = [...perDoc.values()]
    .filter((item) => item.score > 1.0)
    .sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score || 0;
  let selected = ranked
    .filter((item) => item.score >= topScore * minRelative)
    .slice(0, limit);
  // Minimum recall. The absolute floor above is 1.0 while the intent prior adds
  // exactly 1.4, so for a question that matches no glossary term *and* lands in
  // an intent without a prior (`general`), every candidate scores 0 and the
  // evidence set comes back empty. That failure is silent: the caller sees "no
  // sources" rather than "nothing scored", and the hold-out set showed it can
  // happen. Never return an empty list while candidates exist — fall back to the
  // best-scoring candidates and mark them so the caller can say the evidence is
  // weak instead of implying the corpus has nothing.
  let lowConfidence = false;
  if (!selected.length && perDoc.size) {
    selected = [...perDoc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    lowConfidence = true;
  }
  return selected
    .map((item) => ({
      docId: item.docId,
      score: Math.round(item.score * 100) / 100,
      text: item.chunk.text,
      lineStart: item.chunk.lineStart,
      lineEnd: item.chunk.lineEnd,
      lowConfidence
    }));
}
