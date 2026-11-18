// Claim-level evidence verification.
//
// The model writes Chinese prose while the evidence is mostly English source
// text, so a claim is considered supported when any of three checks passes:
//   1. an anchor (code path, backticked identifier, URL) occurs in the evidence;
//   2. most distinctive ASCII identifiers in the claim (apache, timeout, session)
//      occur in the evidence;
//   3. a contiguous window of the evidence covers most of the claim's character
//      bigrams (overlap coefficient), which catches vocabulary-level paraphrase.
//
// When a claim cites an evidence marker such as [E2], support is first checked
// against that document only. If the claim is supported by some other document
// but not by the one it cites, it is reported as "miscited" — the failure mode
// where the model pulls a true sentence from the wrong file.
//
// Advice sentences and statements about evidence sufficiency are excluded from
// the denominator, so coverage describes factual claims rather than style.

import { bigramSet, overlapRatio, splitClaims } from './text.mjs';

const ANCHOR = /`([^`]{3,80})`|((?:[\w.-]+\/)+[\w.-]+\.(?:py|md|rst|txt|toml|cfg|ya?ml|json))|(https?:\/\/\S+)/g;
const ASCII_TOKEN = /[a-z][a-z0-9_.-]{3,}/g;
const CITATION = /\[E(\d+)\]/gi;
const GENERIC_TOKENS = new Set(['requests', 'http', 'https', 'python', 'license', 'test', 'tests', 'issue', 'pull', 'request', 'main', 'code', 'openbridge', 'github', 'must', 'should', 'will', 'with', 'that', 'from', 'this']);

// Format layer: URLs and file paths are not "does this paragraph talk about the
// same topic" claims; they are copy targets. A sentence can be semantically
// grounded yet still be unsafe to copy because it contains a typo'd URL or path
// (the 4/12 review found exactly this: api.p, https//..., http.bin.org). This
// layer is intentionally separate from the three-state result so the historical
// 42/82 and 6/2/4 numbers do not need a re-calibration.
const URL_LIKE = /\bhttps?:?\/{1,2}[^\s)\]）>]+/gi;
const PATH_LIKE = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/g;
const FILE_LIKE = /\b[\w-]+\.(?:py|p|md|rst|txt|toml|cfg|ya?ml|json|lock|ini)\b/gi;
const FILE_EXT = /\.(?:py|p|md|rst|txt|toml|cfg|ya?ml|json|lock|ini)$/i;
const DOMAIN_LIKE = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|cn|edu|gov|co|uk|de|jp|app|sh|xyz|me)\b/gi;

function trimToken(token) {
  return String(token || '')
    .replace(/[.,;:!?，。；：！？、]+$/u, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/[)\]）]+$/, '');
}

function evidenceHasToken(hay, token) {
  const needle = String(token || '').trim().toLowerCase();
  if (!needle) return false;
  // Boundary-aware: "api.p" must not be satisfied by "api.py". This is the
  // exact bug the human review found, so substring matching is not enough.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_.-])${escaped}(?=$|[^a-z0-9_.-])`, 'i').test(hay);
}

/**
 * Check every URL, path and bare domain in a claim against the evidence text.
 * Returns { ok, errors:[{type, token}] }. It does not change the claim's state:
 * a format error is a copy-safety warning, not a semantic support verdict.
 */
function formatCheck(text, evidenceText) {
  const hay = normalizeText(evidenceText);
  const errors = [];
  const seen = new Set();
  const add = (type, token) => {
    const key = `${type}:${token}`;
    if (!seen.has(key)) {
      seen.add(key);
      errors.push({ type, token });
    }
  };

  const source = String(text ?? '');
  for (const match of source.matchAll(URL_LIKE)) {
    const token = trimToken(match[0]);
    if (!token) continue;
    if (!/^https?:\/\/[^/\s]+/i.test(token)) {
      add('url_syntax', token);
      continue;
    }
    let url;
    try {
      url = new URL(token);
    } catch {
      add('url_syntax', token);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!evidenceHasToken(hay, host)) {
      add('url_host', token);
      continue;
    }
    const pathname = url.pathname;
    // The path follows the host directly (`httpbin.org/get`), so a leading
    // word-boundary check would reject every valid URL. A plain substring check
    // is enough here: the host was already checked, and the path is only used
    // to catch a URL that was copied from a different page.
    if (pathname && pathname !== '/' && !hay.includes(pathname.toLowerCase())) {
      add('url_path', token);
    }
  }

  const rest = source.replace(URL_LIKE, ' ');
  for (const match of rest.matchAll(PATH_LIKE)) {
    const token = trimToken(match[0]);
    if (token && !evidenceHasToken(hay, token)) add('path', token);
  }
  for (const match of rest.matchAll(FILE_LIKE)) {
    const token = trimToken(match[0]);
    if (token && !evidenceHasToken(hay, token)) add('file', token);
  }
  for (const match of rest.matchAll(DOMAIN_LIKE)) {
    const token = trimToken(match[0]);
    if (!token || FILE_EXT.test(token)) continue;
    if (!evidenceHasToken(hay, token)) add('domain', token);
  }

  return { ok: errors.length === 0, errors };
}

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

function anchorsOf(claim) {
  const found = [];
  for (const match of claim.matchAll(ANCHOR)) {
    const value = (match[1] || match[2] || match[3] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
    if (value.length >= 3) found.push(value);
  }
  return found;
}

function asciiTokensOf(claim) {
  return [...new Set((normalizeText(claim).match(ASCII_TOKEN) || []).filter((token) => !GENERIC_TOKENS.has(token)))];
}

function citedIndexes(claim) {
  return [...new Set([...claim.matchAll(CITATION)].map((match) => Number(match[1])))];
}

function anchorSupported(anchor, evidenceNorm) {
  const needle = normalizeText(anchor).replace(/^\.?\//, '').replace(/\s+/g, '');
  if (!needle) return false;
  if (evidenceNorm.includes(needle)) return true;
  const parts = needle.split(/[/\\]/).filter(Boolean);
  return parts.length > 1 && evidenceNorm.includes(parts.at(-1));
}

function windowCoverage(claimSet, evidence) {
  const norm = normalizeText(evidence);
  const windowSize = Math.min(Math.max(120, Math.ceil(norm.length / 60)), 600);
  let best = 0;
  for (let start = 0; start < norm.length; start += Math.max(12, Math.floor(windowSize / 4))) {
    const ratio = overlapRatio(claimSet, bigramSet(norm.slice(start, start + windowSize)));
    if (ratio > best) best = ratio;
    if (best >= 0.95) break;
  }
  return best;
}

function isSpecific(claim, anchors, tokens) {
  const stripped = claim.replace(/\[[^\]]{1,16}\]/g, '').replace(/【[^】]{1,16}】/g, '');
  if (anchors.length || tokens.length) return true;
  if (/[“"'][^”"']{2,}[”"']/.test(stripped)) return true;
  return /\d/.test(stripped);
}

// ---------------------------------------------------------------------------
// R1: asserted values must appear in the evidence.
// R2: an asserted name that appears nowhere must not ride on the names that do.
//
// The word-level rules above ask "does this file talk about the same thing?".
// That is not enough for a sentence that states a checkable fact: the self-check
// in data/test-cases.json showed that "Kenneth Reitz currently works at
// Microsoft" was accepted because the *name* appears in the README, while the
// asserted employer appears nowhere, and that "the default retry count is 3" was
// accepted because the digit 3 occurs somewhere in the evidence.
//
// R1 takes the values a sentence commits to — dates, version numbers, numbers and
// percentages — and requires each one to be present in the retrieved evidence.
// Numbers are compared as whole number tokens (so "3" does not match "3.10"), and
// dates are compared as contiguous sequences of number tokens (so 2026-06-01 does
// not match a file that only mentions 2026). R2 covers the same failure mode for
// names: when part of a sentence is matched by the evidence but another name in it
// is not, that unmatched name is a fabricated entity rather than a paraphrase.
//
// Both run on the whole evidence set rather than on the cited document alone, so a
// correct value or name that merely sits in a neighbouring file is not reported.
// ---------------------------------------------------------------------------

// Values inside backticked identifiers or URLs are already covered by the anchor
// rule, and a URL's digits are not a claim about the project.
const VALUE_STRIP = /`[^`]*`|https?:\/\/\S+/g;
const VALUE_PATTERNS = [
  { kind: 'date', re: /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\d{4}[-/]\d{1,2}[-/]\d{1,2}/g },
  { kind: 'version', re: /(?<![\w.])\d+\.\d+(?:\.\d+)?(?![\w.])/g },
  { kind: 'number', re: /\d{3,}|\d+(?=\s*(?:次|个|条|天|周|秒|分钟|小时))/g },
  { kind: 'percent', re: /\d+(?:\.\d+)?\s*%/g }
];
const NUMBER_TOKEN = /\d+(?:\.\d+)*/g;
// A capitalised run is how an English name appears inside Chinese prose.
const PROPER_NOUN = /\b[A-Z][A-Za-z0-9]{1,}(?:[-\s][A-Z][A-Za-z0-9]{1,})*\b/g;
// Names that belong to this project rather than to the retrieved upstream
// evidence, so their absence from the evidence is not a fabrication.
const SELF_NAMES = new Set(['openbridge', 'aic', 'openbridge开源桥']);

/** "09" and "9" are the same date component; "3.10" must stay "3.10". */
function normalizedNumber(token) {
  return String(token)
    .split('.')
    .map((part, position) => (position === 0 ? String(Number(part)) : part))
    .join('.');
}

function assertedValues(claim) {
  const text = String(claim ?? '').replace(VALUE_STRIP, ' ');
  const found = [];
  for (const { kind, re } of VALUE_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[0].trim();
      if (value) found.push({ kind, text: value });
    }
  }
  // A version like 3.10 is also a number; keep the most specific kind only.
  const seen = new Set();
  return found.filter((item) => {
    const key = `${item.kind}:${normalizeText(item.text).replace(/\s+/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (item.kind === 'number') {
      const digits = item.text;
      const shadowed = found.some((other) => other !== item && other.text.includes(digits) && (other.kind === 'date' || other.kind === 'version'));
      if (shadowed) return false;
    }
    return true;
  });
}

function buildValueIndex(evidence) {
  const tight = evidence.map((item) => item.norm.replace(/\s+/g, '')).join('\n');
  const plain = evidence.map((item) => item.norm).join('\n');
  const numbers = new Set();
  const sequence = [];
  for (const item of evidence) {
    for (const match of String(item.text ?? '').matchAll(NUMBER_TOKEN)) {
      const value = normalizedNumber(match[0]);
      numbers.add(value);
      sequence.push(value);
    }
  }
  return { tight, plain, numbers, numberSeq: sequence.join('|') };
}

function valueIsSupported(value, index) {
  const tightValue = normalizeText(value.text).replace(/\s+/g, '');
  if (value.kind === 'percent') return index.tight.includes(tightValue);
  if (value.kind === 'version') return index.tight.includes(tightValue) || index.numbers.has(normalizedNumber(value.text));
  if (value.kind === 'date') {
    const sequence = (value.text.match(NUMBER_TOKEN) || []).map(normalizedNumber).join('|');
    return index.tight.includes(tightValue) || (sequence ? index.numberSeq.includes(sequence) : false);
  }
  return index.numbers.has(normalizedNumber(value.text));
}

/**
 * R2: names asserted by the sentence that the evidence does not contain.
 * Only applies to the "partly matched" case — if the evidence matches at least one
 * of the sentence's terms, an unmatched name in the same sentence is an asserted
 * entity rather than a paraphrase of the evidence.
 *
 * Restricted to single-word names. Multi-word capitalised phrases are usually the
 * role or title of a document being cited ("Security Policy", "Draft Security
 * Advisory") rather than an asserted entity, and checking them produced false
 * positives on the real answers. Single words are the organisation/product shape
 * that the fabricated case ("... currently works at Microsoft") takes.
 */
function assertedEntities(claim, index) {
  const text = String(claim ?? '').replace(VALUE_STRIP, ' ');
  const tokens = asciiTokensOf(claim);
  if (!tokens.length) return [];
  const matched = tokens.filter((token) => index.plain.includes(token));
  if (!matched.length || matched.length === tokens.length) return [];
  const names = [...text.matchAll(PROPER_NOUN)].map((match) => match[0].trim());
  return names.filter((name) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return false;
    const key = normalizeText(name);
    if (key.length < 4) return false;
    if (SELF_NAMES.has(key)) return false;
    if (GENERIC_TOKENS.has(key)) return false;
    return !index.plain.includes(key) && !index.tight.includes(key);
  });
}

/**
 * R3: the attribute a quantified sentence is about must exist in the evidence.
 *
 * "requests.get 的默认重试次数是 3 次" survived R1 and R2: the digit 3 does occur
 * in the evidence (inside "3-tuple" and a URL-encoded %3D), and "requests.get" is a
 * real identifier. What is fabricated is the *attribute* — nothing in the retrieved
 * files says anything about retries. R3 applies only to sentences that quantify
 * something with a Chinese measure word (次/个/条/天/周/遍) and only for attribute
 * words in a small, hand-maintained glossary, so it stays a check we can defend
 * rather than a guess: if the sentence names no known attribute, R3 stays silent and
 * the word-level rules decide. Every attribute it recognises must be supported.
 */
const MEASURE_PHRASE = /\d+\s*(?:次|个|条|天|周|遍)/;
const ATTRIBUTE_TERMS = {
  '重试': ['retry', 'retries'],
  '次数': ['retry', 'retries', 'times', 'count'],
  '默认': ['default'],
  '参数': ['parameter', 'argument', 'param'],
  '版本': ['version'],
  '端口': ['port'],
  '长度': ['length'],
  '大小': ['size', 'length'],
  '数量': ['number', 'count', 'total'],
  '贡献者': ['contributor'],
  '维护者': ['maintainer'],
  '作者': ['author'],
  '下载量': ['download'],
  '超时': ['timeout'],
  '错误码': ['error', 'code'],
  '状态码': ['status']
};

function unsupportedAttributes(claim, index) {
  const text = String(claim ?? '').replace(VALUE_STRIP, ' ');
  if (!MEASURE_PHRASE.test(text)) return [];
  const named = Object.entries(ATTRIBUTE_TERMS).filter(([phrase]) => text.includes(phrase));
  if (!named.length) return [];
  return named.filter(([, terms]) => !terms.some((term) => index.plain.includes(term))).map(([phrase]) => phrase);
}

/** Score a claim against a set of evidence documents. */
function evaluate(claim, evidence) {
  const claimSet = bigramSet(claim);
  const anchors = anchorsOf(claim);
  const tokens = asciiTokensOf(claim);
  const combined = evidence.map((item) => item.norm).join('\n');
  const matchedAnchors = anchors.filter((anchor) => anchorSupported(anchor, combined));
  const matchedTokens = tokens.filter((token) => combined.includes(token));
  const tokenOk = tokens.length > 0 && matchedTokens.length >= 1 && matchedTokens.length / tokens.length >= 0.6;

  let best = { score: 0, evidenceId: null };
  for (const item of evidence) {
    const score = windowCoverage(claimSet, item.text);
    if (score > best.score) best = { score, evidenceId: item.id };
  }
  const anchorOk = anchors.length > 0 && matchedAnchors.length > 0;
  const grounded = anchorOk || tokenOk || best.score >= 0.42;
  return { grounded, anchorOk, tokenOk, matchedAnchors, matchedTokens, score: best.score, evidenceId: best.evidenceId, anchors, tokens };
}

/**
 * @param {string} answer
 * @param {Array<{id:string, title?:string, evidenceText?:string, content?:string, tags?:string[]}>} docs
 */
export function verifyClaims(answer, docs) {
  const claims = splitClaims(answer).filter((claim) => claim.kind !== 'heading');
  // Titles and source URLs are evidence too: they are how a reader locates the
  // file (e.g. "SECURITY.md" appears in the GitHub URL, not in its body).
  const evidence = docs.map((doc) => {
    const text = `${doc.title || ''}\n${doc.source || ''}\n${doc.evidenceText || ''}\n${doc.content || ''}\n${(doc.tags || []).join(' ')}`;
    return { id: doc.id, text, norm: normalizeText(text) };
  });
  const valueIndex = buildValueIndex(evidence);
  const formatEvidence = evidence.map((item) => item.text).join('\n');

  const results = claims.map((claim) => {
    if (claim.kind === 'advice' || claim.kind === 'meta') {
      return {
        ...claim,
        state: claim.kind,
        specific: false,
        reason: claim.kind === 'meta' ? '对证据充分性的说明，不计入' : '建议性表述，不计入事实核验',
        score: null,
        evidenceId: null,
        format: null,
        copySafe: false
      };
    }

    const cited = citedIndexes(claim.text).filter((index) => index >= 1 && index <= evidence.length);
    const citedEvidence = cited.map((index) => evidence[index - 1]);
    const primary = citedEvidence.length ? evaluate(claim.text, citedEvidence) : evaluate(claim.text, evidence);
    const specific = isSpecific(claim.text, primary.anchors, primary.tokens);
    const rounded = Math.round((primary.anchorOk ? Math.max(primary.score, 0.9) : primary.score) * 100) / 100;
    const format = formatCheck(claim.text, formatEvidence);

    // Cited document does not support the sentence, but another document does.
    let miscited = null;
    if (!primary.grounded && citedEvidence.length) {
      const elsewhere = evaluate(claim.text, evidence.filter((item) => !cited.includes(evidence.indexOf(item) + 1)));
      if (elsewhere.grounded) miscited = { index: cited[0], otherId: elsewhere.evidenceId };
    }

    if (miscited) {
      return {
        text: claim.text, kind: 'fact', state: 'miscited', specific: true,
        reason: `句子引用了 [E${miscited.index}]，但该说法只在 ${miscited.otherId} 中出现`,
        score: rounded, evidenceId: miscited.otherId, format, copySafe: false
      };
    }

    // R1: a stated date / version / large number / percentage that appears
    // nowhere in the retrieved evidence is a fabricated value, however well the
    // surrounding wording matches. This takes precedence over the word-level
    // rules, which is the whole point: they accept an entity name as proof.
    const missingValues = assertedValues(claim.text).filter((value) => !valueIsSupported(value, valueIndex));
    if (missingValues.length) {
      return {
        text: claim.text, kind: 'fact', state: 'unsupported', specific: true,
        reason: `断言的具体值在证据中找不到：${missingValues.map((value) => value.text).slice(0, 3).join('、')}`,
        score: rounded, evidenceId: null, unsupportedValues: missingValues, format, copySafe: false
      };
    }

    // R2: the evidence matches part of this sentence, but a name it asserts is
    // nowhere in the evidence — the entity is fabricated, not paraphrased.
    const missingEntities = assertedEntities(claim.text, valueIndex);
    if (missingEntities.length) {
      return {
        text: claim.text, kind: 'fact', state: 'unsupported', specific: true,
        reason: `断言的名称在证据中找不到：${missingEntities.slice(0, 3).join('、')}`,
        score: rounded, evidenceId: null, unsupportedEntities: missingEntities, format, copySafe: false
      };
    }

    // R3: the quantified attribute itself is absent from the evidence.
    const missingAttributes = unsupportedAttributes(claim.text, valueIndex);
    if (missingAttributes.length) {
      return {
        text: claim.text, kind: 'fact', state: 'unsupported', specific: true,
        reason: `断言的属性在证据中找不到：${missingAttributes.slice(0, 3).join('、')}`,
        score: rounded, evidenceId: null, unsupportedAttributes: missingAttributes, format, copySafe: false
      };
    }

    const state = primary.grounded ? 'grounded' : specific && primary.score < 0.3 ? 'unsupported' : 'paraphrase';
    let reason;
    if (primary.grounded) {
      if (primary.anchorOk) reason = `引用标识可在证据中找到：${primary.matchedAnchors.slice(0, 2).join('、')}`;
      else if (primary.tokenOk) reason = `关键英文术语出现在证据中：${primary.matchedTokens.slice(0, 3).join('、')}`;
      else reason = '与证据片段的用词高度重合';
    } else if (state === 'unsupported') {
      reason = primary.anchors.length ? `引用标识未在证据中出现：${primary.anchors[0].slice(0, 40)}` : '具体事实在证据中找不到对应表述';
    } else {
      reason = '语义改写，未做字面覆盖，需人工判断';
    }
    return {
      text: claim.text, kind: 'fact', state, specific,
      supported: state === 'grounded', reason, score: rounded,
      evidenceId: state === 'grounded' ? primary.evidenceId : null,
      format, copySafe: state === 'grounded' && format.ok
    };
  });

  const factual = results.filter((claim) => claim.kind === 'fact');
  const grounded = factual.filter((claim) => claim.state === 'grounded').length;
  const paraphrased = factual.filter((claim) => claim.state === 'paraphrase').length;
  const unsupported = factual.filter((claim) => claim.state === 'unsupported');
  const miscited = factual.filter((claim) => claim.state === 'miscited');
  const unsupportedByValue = unsupported.filter((claim) => (claim.unsupportedValues || []).length);
  const unsupportedByEntity = unsupported.filter((claim) => (claim.unsupportedEntities || []).length);
  const unsupportedByAttribute = unsupported.filter((claim) => (claim.unsupportedAttributes || []).length);
  const formatChecked = factual.filter((claim) => claim.format);
  const formatFlagged = formatChecked.filter((claim) => claim.format && !claim.format.ok);
  const copySafe = factual.filter((claim) => claim.copySafe);
  return {
    claims: results,
    factualClaims: factual.length,
    groundedClaims: grounded,
    paraphrasedClaims: paraphrased,
    unsupportedClaims: unsupported.length,
    misCitedClaims: miscited.length,
    // How many of the unsupported sentences were caught by the value rule (R1), the
    // name rule (R2) or the attribute rule (R3) rather than by the word-level rules.
    // Reported separately so the effect of each rule stays measurable.
    unsupportedByValueClaims: unsupportedByValue.length,
    unsupportedByValue: unsupportedByValue.map((claim) => `${claim.text}［${(claim.unsupportedValues || []).map((value) => value.text).join('、')}］`),
    unsupportedByEntityClaims: unsupportedByEntity.length,
    unsupportedByEntity: unsupportedByEntity.map((claim) => `${claim.text}［${(claim.unsupportedEntities || []).join('、')}］`),
    unsupportedByAttributeClaims: unsupportedByAttribute.length,
    unsupportedByAttribute: unsupportedByAttribute.map((claim) => `${claim.text}［${(claim.unsupportedAttributes || []).join('、')}］`),
    unsupported: [...unsupported, ...miscited].map((claim) => claim.text),
    // Format layer: separate from the three-state result so the historical
    // grounded/paraphrased/unsupported counts stay comparable.
    formatCheckedClaims: formatChecked.length,
    formatFlaggedClaims: formatFlagged.length,
    formatFlagged: formatFlagged.map((claim) => `${claim.text}［${(claim.format.errors || []).map((error) => error.token).join('、')}］`),
    copySafeClaims: copySafe.length,
    copySafeRate: factual.length ? Math.round((copySafe.length / factual.length) * 100) : null,
    copySafe: copySafe.map((claim) => claim.text),
    formatMethod: '格式层（独立于三态）：逐句提取 URL、路径、文件名和裸域名，URL 先查 https?:/{1,2} 的斜杠格式，再用 URL 解析校验 host 与 path 是否在证据原文中出现；路径/文件名要求整体逐字出现；裸域名要求出现在证据中。只要有一项不通过，copySafe=false，但不改变该句原有的有据/改写/无据判定，也不改变 42/82 的历史口径。',
    coverage: factual.length ? Math.round((grounded / factual.length) * 100) : null,
    method: '按句核验：先做三项断言校验——① 值校验：句子中出现的日期、版本号、数字（按完整数字记号比较，"3" 不等于 "3.10"）必须在检索到的证据里找到，日期还需按相邻数字序列匹配；② 名称校验：当证据命中了句子的一部分、但句中另有一个专有名称在证据里完全不存在时判为"无据"；③ 属性校验：句子用中文量词（次/个/条/天/周/遍）量化某个属性时，该属性在术语表里对应的英文词必须在证据中出现，否则判为"无据"。三项都通过后，引用标识或关键英文术语在证据中出现，或该句与证据窗口的字符二元组重合度≥0.42 记为“有据”；引用了 A 资料却只能由 B 资料支持记为“错引”；不含数字、路径和标识符的改写句记为“语义改写”；含具体事实却无任何字面支撑的句子记为“无据”。'
  };
}
