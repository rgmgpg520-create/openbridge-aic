import fs from 'node:fs/promises';

const base = process.env.OPENBRIDGE_URL || 'http://127.0.0.1:4173';
const questions = JSON.parse(await fs.readFile(new URL('../benchmark/questions.json', import.meta.url), 'utf8'));
const out = {
  generatedAt: new Date().toISOString(),
  model: 'Qwen3-VL-2B-Instruct',
  mode: 'Requests fixed snapshot RAG vs baseline',
  configuration: { questionCount: questions.length, maxTokens: 520, temperature: 0.1 },
  results: []
};

const statusResponse = await fetch(`${base}/api/status`);
if (!statusResponse.ok) throw new Error(`Model status request failed: ${statusResponse.status}`);
const status = await statusResponse.json();
if (!status.online) throw new Error('Local model is offline; start model/serve.py before benchmarking. No results were written.');

const ask = async (question, mode) => {
  // A transient model-server hiccup (or a one-off rule-fallback) used to abort
  // the whole 12-case run. Retry with backoff so a single jitter does not waste
  // a full run; scoring logic is unchanged.
  const maxAttempts = 4;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: question.query, mode })
      });
      if (!response.ok) throw new Error(`${mode} request failed: ${response.status}`);
      const payload = await response.json();
      if (!payload.ai) throw new Error(`${mode} answer was a rule-fallback (model not used)`);
      return { ...payload, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const waitMs = 5000 * attempt;
        console.warn(`[${question.id}/${mode}] attempt ${attempt} failed: ${error.message}; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw new Error(`${mode} ${question.id} failed after ${maxAttempts} attempts: ${lastError.message}`);
};

for (const question of questions) {
  const baseline = await ask(question, 'baseline');
  const rag = await ask(question, 'rag');
  if (!baseline.ai) throw new Error(`Baseline ${question.id} did not use the local model; no results were written.`);
  const hit = (answer) => question.expected.filter((item) => answer.toLowerCase().includes(item.toLowerCase())).length;
  const expectedSourceHit = rag.sources?.some((source) => source.id === question.source) || false;
  out.results.push({
    id: question.id,
    query: question.query,
    expectedSource: question.source,
    baseline: {
      answer: baseline.answer,
      keywordHits: hit(baseline.answer),
      keywordTotal: question.expected.length,
      keywordCoverage: hit(baseline.answer) / question.expected.length,
      ai: baseline.ai,
      responseMode: 'model',
      latencyMs: baseline.latencyMs
    },
    rag: {
      answer: rag.answer,
      keywordHits: hit(rag.answer),
      keywordTotal: question.expected.length,
      keywordCoverage: hit(rag.answer) / question.expected.length,
      ai: rag.ai,
      responseMode: rag.ai ? 'model' : 'rule-fallback',
      model: rag.model,
      latencyMs: rag.latencyMs,
      sourceHit: expectedSourceHit,
      sources: rag.sources,
      verification: rag.verification
        ? {
          factualClaims: rag.verification.factualClaims,
          groundedClaims: rag.verification.groundedClaims,
          paraphrasedClaims: rag.verification.paraphrasedClaims,
          unsupportedClaims: rag.verification.unsupportedClaims,
          coverage: rag.verification.coverage,
          unsupported: rag.verification.unsupported
        }
        : null
    },
    humanReview: question.review || ''
  });
}

function summarize(key) {
  const rows = out.results.map((result) => result[key]);
  const average = (field) => Math.round(rows.reduce((sum, row) => sum + (row[field] || 0), 0) / Math.max(rows.length, 1) * 100) / 100;
  return {
    cases: rows.length,
    averageKeywordCoverage: average('keywordCoverage'),
    averageLatencyMs: Math.round(rows.reduce((sum, row) => sum + row.latencyMs, 0) / Math.max(rows.length, 1)),
    fullKeywordCases: rows.filter((row) => row.keywordHits === row.keywordTotal).length,
    modelGeneratedCases: rows.filter((row) => row.ai).length,
    ruleFallbackCases: rows.filter((row) => row.responseMode === 'rule-fallback').length
  };
}

const rag = summarize('rag');
out.summary = {
  baseline: summarize('baseline'),
  rag: {
    ...rag,
    expectedSourceHitRate: Math.round(out.results.filter((result) => result.rag.sourceHit).length / out.results.length * 100),
    groundedClaims: out.results.reduce((sum, result) => sum + (result.rag.verification?.groundedClaims || 0), 0),
    factualClaims: out.results.reduce((sum, result) => sum + (result.rag.verification?.factualClaims || 0), 0),
    unsupportedClaims: out.results.reduce((sum, result) => sum + (result.rag.verification?.unsupportedClaims || 0), 0)
  }
};

const outPath = process.env.OPENBRIDGE_OUT || new URL('../results/latest-results.json', import.meta.url);
await fs.mkdir(new URL('../results/', import.meta.url), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ file: String(outPath), cases: out.results.length, summary: out.summary }, null, 2));
