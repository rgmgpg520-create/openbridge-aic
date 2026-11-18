// Refresh the sentence-level verification recorded for the 12 stored answers.
//
// The answers were generated once by the local model and are kept as they were.
// Verification, however, is a deterministic post-process, so when the verifier
// changes (R1 value rule, R2 name rule) the recorded counts must be recomputed —
// otherwise results/latest-results.json and the report describe an older rule than
// the one the code implements. This needs the project server for the same evidence
// windows, but it does NOT need the model.
//
// Usage: start `node server.mjs`, then run `node scripts/reverify-results.mjs`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyClaims } from '../lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.OPENBRIDGE_URL || 'http://127.0.0.1:4173';

const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data/sample-project.json'), 'utf8'));
const byId = Object.fromEntries(project.documents.map((doc) => [doc.id, doc]));
const questions = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark/questions.json'), 'utf8'));
const byQuestion = Object.fromEntries(questions.map((q) => [q.id, q]));
const resultsPath = path.join(ROOT, 'results/latest-results.json');
const stored = JSON.parse(await fs.readFile(resultsPath, 'utf8'));

const totals = { factualClaims: 0, groundedClaims: 0, paraphrasedClaims: 0, unsupportedClaims: 0, misCitedClaims: 0, unsupportedByValueClaims: 0, unsupportedByEntityClaims: 0, unsupportedByAttributeClaims: 0 };
for (const row of stored.results || []) {
  const question = byQuestion[row.id];
  if (!question) { console.log(`no question for ${row.id}, skipped`); continue; }
  const response = await fetch(`${BASE}/api/evidence`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: question.query })
  });
  if (!response.ok) throw new Error(`evidence request failed: ${response.status}`);
  const payload = await response.json();
  const docs = payload.retrieval.hits.map((hit) => ({ ...byId[hit.id], ...hit, content: byId[hit.id]?.content || '' }));
  const check = verifyClaims(row.rag.answer, docs);
  const previous = row.rag.verification || {};
  row.rag.verification = {
    factualClaims: check.factualClaims,
    groundedClaims: check.groundedClaims,
    paraphrasedClaims: check.paraphrasedClaims,
    unsupportedClaims: check.unsupportedClaims,
    misCitedClaims: check.misCitedClaims,
    unsupportedByValueClaims: check.unsupportedByValueClaims,
    unsupportedByEntityClaims: check.unsupportedByEntityClaims,
    unsupportedByAttributeClaims: check.unsupportedByAttributeClaims,
    coverage: check.coverage,
    unsupported: check.unsupported,
    unsupportedByValue: check.unsupportedByValue,
    unsupportedByEntity: check.unsupportedByEntity,
    unsupportedByAttribute: check.unsupportedByAttribute,
    method: check.method
  };
  for (const key of Object.keys(totals)) totals[key] += row.rag.verification[key];
  const delta = check.groundedClaims - (previous.groundedClaims ?? 0);
  console.log(`${row.id}  有据 ${check.groundedClaims}/${check.factualClaims}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}  无据 ${check.unsupportedClaims}（值 ${check.unsupportedByValueClaims} / 名 ${check.unsupportedByEntityClaims}）`);
}

stored.summary = stored.summary || {};
stored.summary.rag = { ...(stored.summary.rag || {}), ...totals };
stored.reverifiedAt = new Date().toISOString();
stored.reverifiedWith = 'lib/verify.mjs R1 值级校验 + R2 断言名称校验';
await fs.writeFile(resultsPath, JSON.stringify(stored, null, 2));
console.log('\n汇总:', JSON.stringify(totals));
console.log(`字面有据率 ${(totals.groundedClaims / Math.max(totals.factualClaims, 1) * 100).toFixed(0)}%`);
console.log('已写入 results/latest-results.json（回答本身未改动）');