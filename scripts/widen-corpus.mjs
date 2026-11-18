// Widen the retrieval corpus with more files from the SAME pinned Requests commit.
//
// Measured on 2026-10-26: adding these five documents without re-labelling the
// evaluation sets degrades every metric (dev 32/32 -> 29/32, top-1 82% -> 57%;
// hold-out R@1 63% -> 42%, R@3 96% -> 79%, misses 1 -> 5). The reason is that both
// question sets were labelled against the seven-document snapshot, and the new
// documents are often the semantically better source (docs/user/advanced.rst for
// timeout and Session questions, docs/user/install.rst for installation). Use this
// script together with a fresh hold-out set and a re-run of scripts/benchmark.mjs,
// not on its own. Details and numbers: docs/错误分析.md, section E8.
//
// Needs network and write access to data/ and resources/ (run it outside the
// sandboxed shell, which cannot reach GitHub over Node's HTTP client).
//
// Usage:  node scripts/widen-corpus.mjs [--commit <sha>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_COMMIT = '611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60';
const commitArg = process.argv.indexOf('--commit');
const COMMIT = commitArg > -1 ? process.argv[commitArg + 1] : DEFAULT_COMMIT;

const FILES = [
  { upstream: 'docs/user/quickstart.rst', local: 'docs_user_quickstart.rst', id: 'quickstart', title: '用户指南：快速上手（Quickstart）',
    content: '官方快速上手文档：如何发起 GET 与 POST 请求、传递 URL 参数、读取响应编码与二进制内容、自定义请求头、发送表单与 JSON、传递 cookie、处理重定向、超时与异常。文档中的示例代码可直接运行。',
    tags: ['快速上手', 'quickstart', '示例', '代码', 'GET', 'POST', '参数', '请求头', '超时', '异常', '教程', '用法'] },
  { upstream: 'docs/user/advanced.rst', local: 'docs_user_advanced.rst', id: 'advanced', title: '用户指南：高级用法（Advanced）',
    content: '官方高级用法文档：会话对象与连接复用、请求与响应对象、SSL 证书验证与自定义 CA、REQUESTS_CA_BUNDLE、代理与 SOCKS、超时取值、重试与最大重试次数、流式上传下载、事件钩子与自定义适配器。',
    tags: ['高级', 'advanced', 'Session', '会话', '连接复用', 'SSL', '证书', 'verify', '代理', 'proxies', '超时', 'timeout', '重试', '流式', '适配器'] },
  { upstream: 'docs/user/authentication.rst', local: 'docs_user_authentication.rst', id: 'authentication', title: '用户指南：认证（Authentication）',
    content: '官方认证文档：基本认证、摘要认证、netrc 认证、自定义认证、OAuth 与令牌传递方式，并说明应把访问令牌放在请求头而不是 URL 中。',
    tags: ['认证', 'authentication', 'token', '令牌', 'basic auth', 'OAuth', 'header'] },
  { upstream: 'docs/community/faq.rst', local: 'docs_community_faq.rst', id: 'faq', title: '常见问题（FAQ）',
    content: '官方常见问题：编码与解码、响应内容处理、SSL 证书验证、代理与网络错误、性能与并发、许可证与版本支持等新手常问主题。',
    tags: ['常见问题', 'FAQ', '编码', 'SSL', '证书', '代理', '性能', '并发', '许可证', '版本'] },
  { upstream: 'docs/user/install.rst', local: 'docs_user_install.rst', id: 'install', title: '用户指南：安装（Installation）',
    content: '官方安装文档：支持的 Python 版本、pip 安装方式、从源码安装与依赖说明。',
    tags: ['安装', 'install', 'pip', 'Python 版本', '依赖', '源码安装'] }
];

const upstreamDir = path.join(ROOT, 'resources/requests/upstream');
const cloneDir = path.join(ROOT, '.widen-corpus-clone');

console.log(`pinned commit: ${COMMIT}`);
await fs.rm(cloneDir, { recursive: true, force: true });
execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', 'https://github.com/psf/requests', path.join(cloneDir, 'requests')], { stdio: 'inherit' });
execFileSync('git', ['-C', path.join(cloneDir, 'requests'), 'sparse-checkout', 'set', 'docs/user', 'docs/community'], { stdio: 'inherit' });
const resolved = execFileSync('git', ['-C', path.join(cloneDir, 'requests'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (resolved !== COMMIT) console.log(`WARNING: clone resolved to ${resolved}, expected ${COMMIT}`);

for (const file of FILES) {
  const from = path.join(cloneDir, 'requests', file.upstream);
  await fs.copyFile(from, path.join(upstreamDir, file.local));
  console.log(`copied ${file.upstream} -> ${file.local}`);
}
await fs.rm(cloneDir, { recursive: true, force: true });

// Register: rewrite the documents block from parsed data so separators stay correct.
const projectPath = path.join(ROOT, 'data/sample-project.json');
const raw = await fs.readFile(projectPath, 'utf8');
const data = JSON.parse(raw);
for (const file of FILES) {
  if (data.documents.some((doc) => doc.id === file.id)) { console.log(`already registered: ${file.id}`); continue; }
  data.documents.push({
    id: file.id, type: 'DOC', title: file.title,
    source: `https://github.com/psf/requests/blob/${COMMIT}/${file.upstream}`,
    evidencePath: `resources/requests/upstream/${file.local}`,
    content: file.content, tags: file.tags
  });
}
const block = data.documents.map((doc) => `    ${JSON.stringify(doc)}`).join(',\n');
const rewritten = raw.replace(/  "documents": \[[\s\S]*?\n  \],/, `  "documents": [\n${block}\n  ],`);
if (rewritten === raw) { console.error('ABORT: could not locate the documents block'); process.exit(1); }
await fs.writeFile(projectPath, rewritten);
const check = JSON.parse(await fs.readFile(projectPath, 'utf8'));
console.log(`sample-project.json OK, documents = ${check.documents.length}`);

const sourcePath = path.join(ROOT, 'resources/requests/SOURCE.md');
let source = await fs.readFile(sourcePath, 'utf8');
const marker = '目录中的 LICENSE 是上游许可证文本。';
if (!source.includes('本次扩充新增的文件')) {
  const list = (await fs.readdir(upstreamDir)).sort().map((f) => `- \`${f}\``).join('\n');
  source = source.replace(marker, `本次扩充新增的文件（来自同一提交，文件名为原仓库路径以下划线拼接）：\n\n${list}\n\n${marker}`);
  await fs.writeFile(sourcePath, source);
  console.log('SOURCE.md updated');
}
console.log('\nDone. Now re-run: node scripts/capture-validation.mjs && node scripts/eval-retrieval.mjs && node scripts/benchmark.mjs');
console.log('Expect the published metrics to DROP until the evaluation sets are re-labelled — see docs/错误分析.md E8.');