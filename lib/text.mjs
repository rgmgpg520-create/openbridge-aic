// Shared text utilities: normalisation, tokenisation for the lexical index and
// sentence splitting for the evidence verifier. No external dependencies.

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const ASCII_WORD = /[a-z0-9][a-z0-9_./-]*[a-z0-9]/g;

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Terms used by the BM25 index: CJK character bigrams plus ASCII words. */
export function terms(text) {
  const norm = normalize(text);
  const counts = new Map();
  const bump = (term) => counts.set(term, (counts.get(term) || 0) + 1);
  for (const run of norm.match(CJK_RUN) || []) {
    if (run.length === 1) bump(run);
    for (let i = 0; i + 1 < run.length; i += 1) bump(run.slice(i, i + 2));
  }
  for (const word of norm.match(ASCII_WORD) || []) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) bump(word);
    // Module-qualified names: users ask about `requests.post` while the source
    // defines `def post(...)`. Index the trailing attribute as well so the public
    // spelling and the definition meet. File extensions are excluded because
    // `test_requests.py` -> `py` would only add noise.
    const dot = word.lastIndexOf('.');
    if (dot > 0 && dot < word.length - 1) {
      const attribute = word.slice(dot + 1);
      if (attribute.length >= 3 && !STOP_WORDS.has(attribute) && !FILE_EXTENSIONS.has(attribute)) bump(attribute);
    }
  }
  return counts;
}

const FILE_EXTENSIONS = new Set(['py', 'md', 'rst', 'txt', 'json', 'html', 'yml', 'yaml', 'cfg', 'ini', 'toml', 'lock']);

const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'was', 'with', 'that', 'this', 'from', 'you', 'can', 'not', 'into', 'its']);

/** Character bigrams for fuzzy support matching (works for CJK and code text). */
export function bigramSet(text) {
  const norm = normalize(text);
  const set = new Set();
  for (let i = 0; i + 1 < norm.length; i += 1) {
    const pair = norm.slice(i, i + 2);
    if (pair.trim().length === 0) continue;
    set.add(pair);
  }
  return set;
}

export function overlapRatio(needle, haystack) {
  if (!needle.size) return 0;
  let hit = 0;
  for (const item of needle) if (haystack.has(item)) hit += 1;
  return hit / needle.size;
}

const ADVICE = /^\s*(请|建议|注意|务必|不要|避免|记得|先|再|若|如果|可先|最好)|建议|务必|不要|避免|最好|记得/;
const HEADING = /^(结论|行动建议|证据|来源|说明|提示|摘要|答案|核验|参考)[:：]?$/;
const META = /^(证据不足|证据中未|现有证据|目前证据|无法确认|未提供|资料未|证据未)|未提及|未说明|未提供|无法确认|无法确定|并未说明/;
const MARKER = /^(?:\[[^\]]{1,16}\]|【[^】]{1,16}】|[-*•]|\(?\d+[.、)]\)?)\s*/;

/**
 * Split a generated answer into verifiable claims.
 * Lines starting with list markers become their own claim; trailing headings and
 * pure advice sentences are kept but tagged so the verifier can ignore them.
 */
export function splitClaims(answer) {
  const text = String(answer ?? '').replace(/\r/g, '');
  const lines = text.split('\n');
  const claims = [];
  for (const rawLine of lines) {
    let line = rawLine.replace(/^\s*(?:[-*•]|\d+[.、)]|[（(]\d+[)）])\s*/, '').trim();
    while (MARKER.test(line)) line = line.replace(MARKER, '').trim();
    if (!line) continue;
    for (const piece of line.split(/(?<=[。！？；!?;])/)) {
      const claim = piece.trim().replace(/^[。；;，,\s]+/, '');
      if (!claim) continue;
      const isHeading = HEADING.test(claim);
      const isAdvice = ADVICE.test(claim) && !/[`'"][^`'"]+[`'"]|\d/.test(claim);
      const isMeta = META.test(claim);
      claims.push({ text: claim, kind: isHeading ? 'heading' : isMeta ? 'meta' : isAdvice ? 'advice' : 'fact' });
    }
  }
  return claims;
}
