// Retrieval-only evaluation on a hold-out question set.
//
// These questions were written after the development cases and are not used
// to tune the glossary or the ranking. The script reuses the same index and
// ranking code as the server, so the numbers describe the deployed retriever.
//
// Two sets are kept side by side:
//   holdout-questions.json     55 questions (H01-H55). Used once to find defects
//                              and kept afterwards as a regression set.
//   holdout-questions-v2.json  20 questions (J01-J20) written after those fixes
//                              and run exactly once, as an untouched check.
// Pick one with OPENBRIDGE_QUESTIONS=<file name>.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkDocument, buildIndex, search } from '../lib/retrieval.mjs';
import { detectIntent } from '../lib/intent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sample-project.json'), 'utf8'));
const questionsFile = process.env.OPENBRIDGE_QUESTIONS || 'holdout-questions.json';
const questions = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark', questionsFile), 'utf8'));

const entries = [];
for (const doc of project.documents) {
  let text = doc.content || '';
  if (doc.evidencePath) text = await fs.readFile(path.join(ROOT, doc.evidencePath), 'utf8');
  entries.push({ docId: doc.id, type: doc.type, chunks: chunkDocument(text) });
}
const index = buildIndex(entries);

const results = [];
let reciprocalRank = 0;
let hitsAt1 = 0;
let hitsAt3 = 0;
for (const question of questions) {
  const ranked = search(index, question.query, { limit: 3, intent: detectIntent(question.query), documents: project.documents }).map((hit) => hit.docId);
  const rank = ranked.indexOf(question.source) + 1;
  if (rank === 1) hitsAt1 += 1;
  if (rank >= 1 && rank <= 3) hitsAt3 += 1;
  if (rank >= 1) reciprocalRank += 1 / rank;
  results.push({ id: question.id, query: question.query, expected: question.source, ranked, rank, hit: rank === 1 });
}

const summary = {
  cases: questions.length,
  recallAt1: Math.round(hitsAt1 / questions.length * 100),
  recallAt3: Math.round(hitsAt3 / questions.length * 100),
  mrr: Math.round(reciprocalRank / questions.length * 100) / 100,
  misses: results.filter((result) => !result.rank).length
};

const out = { generatedAt: new Date().toISOString(), set: questionsFile, summary, results };
const outPath = process.env.OPENBRIDGE_OUT || path.join(ROOT, 'results', 'holdout-results.json');
await fs.writeFile(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const result of results.filter((item) => !item.rank)) console.log(`MISS ${result.id} ${result.query} expected=${result.expected} got=${result.ranked.join(',') || '(none)'}`);
