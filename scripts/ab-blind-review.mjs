// A/B blind preference review for OpenBridge.
//
// Reads results/latest-results.json (baseline = generic model alone, RAG =
// OpenBridge retrieval + model), shows each pair in randomised A/B order to a
// human reviewer who does NOT know which is which, and records per-question
// preference and correctness scores. This is the "user A/B test" evidence:
// generic model vs OpenBridge, judged by a person rather than by metrics.
//
// Usage:
//   node scripts/ab-blind-review.mjs              # interactive review
//   node scripts/ab-blind-review.mjs --summary     # aggregate saved reviews
//
// Output: results/ab-reviews/<reviewer-id>.json (one per reviewer)
// The A/B mapping is recorded but hidden during the session; reveal it only
// after the reviewer finishes, to keep the review blind.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'results', 'latest-results.json');
const REVIEW_DIR = path.join(ROOT, 'results', 'ab-reviews');

// Deterministic pseudo-random in [0,1): same reviewer + question always gets
// the same A/B layout, but two reviewers get different layouts.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// Line-queue prompter that works in both an interactive TTY and piped input
// (the promise-based readline API closes early when stdin is not a TTY).
function makePrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift().resolve(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift().reject(new Error('EOF'));
  });
  const question = (promptText) => {
    process.stdout.write(promptText);
    return new Promise((resolve, reject) => {
      if (queue.length) resolve(queue.shift());
      else if (closed) reject(new Error('EOF'));
      else waiters.push({ resolve, reject });
    });
  };
  return { question, close: () => rl.close() };
}

function askInLoop(rl, promptText, validate) {
  const loop = () => rl.question(promptText).then((raw) => {
    const value = String(raw).trim();
    const error = validate(value);
    if (error) { console.log(error); return loop(); }
    return value;
  });
  return loop();
}

async function runReview() {
  const data = JSON.parse(await fs.readFile(RESULTS, 'utf8'));
  const cases = data.results;
  const rl = makePrompter();

  console.log('\n========== OpenBridge A/B 盲评 ==========');
  console.log('你将看到同一问题的两个回答（A 和 B），它们来自两种系统，评审时不会告诉你哪个是哪个。');
  console.log('请凭"哪个更准确、更能解决问题、来源更可核对"独立判断。中途按 Ctrl+C 可退出，已答内容会保存。\n');

  const reviewerId = await askInLoop(rl, '评审员代号（如 student01，用于匿名记录）：', (v) =>
    v ? '' : '代号不能为空。');
  const familiarity = await askInLoop(rl, '你对 Requests / HTTP 库的熟悉程度（1=没用过, 2=用过, 3=熟悉）：', (v) =>
    /^[1-3]$/.test(v) ? '' : '请输入 1、2 或 3。');
  const outFile = path.join(REVIEW_DIR, `${reviewerId}.json`);

  const answers = [];
  const startedAt = new Date().toISOString();
  let aborted = false;
  process.on('SIGINT', () => { aborted = true; rl.close(); });

  for (let i = 0; i < cases.length; i++) {
    if (aborted) break;
    const c = cases[i];
    const ragFirst = hash01(`${reviewerId}|${c.id}`) >= 0.5;
    const slots = ragFirst
      ? { A: 'rag', B: 'baseline' }
      : { A: 'baseline', B: 'rag' };
    console.log('\n' + '='.repeat(80));
    console.log(`第 ${i + 1}/${cases.length} 题（${c.id}）：${c.query}\n`);
    console.log('【回答 A】\n' + c[slots.A].answer + '\n');
    console.log('【回答 B】\n' + c[slots.B].answer + '\n');

    let preference, scoreA, scoreB, reason;
    try {
      preference = await askInLoop(
        rl,
        '整体更准确、更有用的是？(A / B / = 平手 / s 跳过)：',
        (v) => (/^[AB=Ss]$/.test(v) ? '' : '请输入 A、B、= 或 s。')
      );
      if (/^[Ss]$/.test(preference)) { answers.push({ id: c.id, layout: slots, skipped: true }); continue; }

      scoreA = await askInLoop(rl, '给回答 A 的正确性打分（1-5，5 最高）：', (v) =>
        /^[1-5]$/.test(v) ? '' : '请输入 1 到 5 的整数。');
      scoreB = await askInLoop(rl, '给回答 B 的正确性打分（1-5，5 最高）：', (v) =>
        /^[1-5]$/.test(v) ? '' : '请输入 1 到 5 的整数。');
      reason = await askInLoop(rl, '判断理由（可留空，直接回车）：', () => '');
    } catch { aborted = true; break; }

    const prefKey = preference === '=' ? 'tie'
      : (preference.toUpperCase() === 'A' ? slots.A : slots.B);
    answers.push({
      id: c.id, layout: slots, skipped: false,
      preference: prefKey,
      scoreRag: Number(slots.A === 'rag' ? scoreA : scoreB),
      scoreBaseline: Number(slots.B === 'baseline' ? scoreB : scoreA),
      reason
    });
  }
  rl.close();

  await fs.mkdir(REVIEW_DIR, { recursive: true });
  const record = {
    reviewerId, familiarity: Number(familiarity), startedAt,
    finishedAt: new Date().toISOString(), aborted,
    sourceResults: data.generatedAt,
    questionCount: cases.length,
    answeredCount: answers.filter((a) => !a.skipped).length,
    answers
  };
  await fs.writeFile(outFile, JSON.stringify(record, null, 2));

  // Per-reviewer quick tally (reveal only at the end).
  const valid = answers.filter((a) => !a.skipped);
  const ragWin = valid.filter((a) => a.preference === 'rag').length;
  const baseWin = valid.filter((a) => a.preference === 'baseline').length;
  const tie = valid.filter((a) => a.preference === 'tie').length;
  const avg = (sel) => valid.length ? (valid.reduce((s, a) => s + sel(a), 0) / valid.length).toFixed(2) : '—';
  console.log('\n盲评已完成（现在揭晓：RAG = OpenBridge，baseline = 通用模型单独作答）');
  console.log(`有效 ${valid.length} 题：OpenBridge 更优 ${ragWin} 题，通用模型更优 ${baseWin} 题，平手 ${tie} 题。`);
  console.log(`平均正确性分：OpenBridge ${avg((a) => a.scoreRag)}，通用模型 ${avg((a) => a.scoreBaseline)}（1-5）。`);
  console.log('记录已保存：' + path.relative(ROOT, outFile));
  console.log('全部评审完成后运行：node scripts/ab-blind-review.mjs --summary');
}

async function summarize() {
  let files = [];
  try { files = (await fs.readdir(REVIEW_DIR)).filter((f) => f.endsWith('.json')); } catch {}
  if (!files.length) { console.log('还没有评审记录，先运行：node scripts/ab-blind-review.mjs'); return; }
  const records = await Promise.all(files.map((f) => fs.readFile(path.join(REVIEW_DIR, f), 'utf8').then(JSON.parse)));
  const validAnswers = records.flatMap((r) => r.answers.filter((a) => !a.skipped));
  const n = validAnswers.length;
  const ragWin = validAnswers.filter((a) => a.preference === 'rag').length;
  const baseWin = validAnswers.filter((a) => a.preference === 'baseline').length;
  const tie = validAnswers.filter((a) => a.preference === 'tie').length;
  const avg = (sel) => n ? validAnswers.reduce((s, a) => s + sel(a), 0) / n : 0;
  const pct = (x) => n ? Math.round(x / n * 1000) / 10 : 0;

  const byQuestion = {};
  for (const a of validAnswers) {
    const q = byQuestion[a.id] || (byQuestion[a.id] = { rag: 0, baseline: 0, tie: 0, n: 0 });
    q[a.preference === 'tie' ? 'tie' : a.preference] += 1; q.n += 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    reviewerCount: records.length,
    reviewers: records.map((r) => ({ id: r.reviewerId, familiarity: r.familiarity, answered: r.answeredCount, aborted: r.aborted })),
    answeredCount: n,
    preference: {
      openbridgeWins: ragWin, baselineWins: baseWin, ties: tie,
      openbridgeWinRate: pct(ragWin), baselineWinRate: pct(baseWin), tieRate: pct(tie)
    },
    averageCorrectness: {
      openbridge: Math.round(avg((a) => a.scoreRag) * 100) / 100,
      baseline: Math.round(avg((a) => a.scoreBaseline) * 100) / 100
    },
    byQuestion
  };
  const outPath = path.join(ROOT, 'results', 'ab-summary.json');
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n汇总已保存：results/ab-summary.json');
}

if (process.argv.includes('--summary')) summarize();
else runReview().catch((err) => { console.error('盲评失败：', err.message); process.exit(1); });
