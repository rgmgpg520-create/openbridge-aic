import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.OPENBRIDGE_URL || 'http://127.0.0.1:4173';
const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sample-project.json'), 'utf8'));
const response = await fetch(`${base}/api/validate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project })
});
if (!response.ok) throw new Error(`Validation request failed: ${response.status}`);
const result = await response.json();
const output = { ...result, capturedAt: new Date().toISOString(), project: project.project.displayName, snapshotCommit: project.project.snapshotCommit };
const outDir = path.join(ROOT, 'results');
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'latest-validation.json'), JSON.stringify(output, null, 2));

// Corpus summary for the report (no chunk text: this record documents how much
// evidence the citation chain covers, not the corpus itself).
const evidenceResponse = await fetch(`${base}/api/evidence`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project })
});
if (!evidenceResponse.ok) throw new Error(`Evidence request failed: ${evidenceResponse.status}`);
const evidence = await evidenceResponse.json();
const evidenceOutput = {
  capturedAt: new Date().toISOString(),
  project: project.project.displayName,
  snapshotCommit: project.project.snapshotCommit,
  totalChunks: evidence.totalChunks,
  averageChunkChars: evidence.averageChunkChars,
  documents: evidence.documents.map((doc) => ({
    id: doc.id, type: doc.type, title: doc.title, chars: doc.chars, chunkCount: doc.chunkCount,
    firstLine: doc.chunks[0]?.lineStart ?? null, lastLine: doc.chunks.at(-1)?.lineEnd ?? null
  }))
};
await fs.writeFile(path.join(outDir, 'latest-evidence.json'), JSON.stringify(evidenceOutput, null, 2));

console.log(JSON.stringify({
  file: 'results/latest-validation.json',
  total: result.total,
  passed: result.passed,
  skipped: result.skipped,
  top1Accuracy: result.top1Accuracy,
  citationRecall: result.citationRecall,
  evidenceCoverage: result.evidenceCoverage,
  injection: result.injectionSummary,
  abstain: result.abstainSummary,
  abstainSelfCheck: result.abstainSelfCheck,
  guardrails: result.guardrailSummary,
  evidenceFile: 'results/latest-evidence.json',
  totalChunks: evidenceOutput.totalChunks
}, null, 2));
