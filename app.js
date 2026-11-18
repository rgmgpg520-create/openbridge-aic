const state = {
  project: null,
  lastQuestion: "",
  lastAnswer: null,
  trace: [],
  tests: [],
  evidence: null,
  evidenceDocId: null
};

const CATEGORY_LABEL = {
  usage: '用法', issue: 'Issue', contribute: '贡献', license: '许可', security: '安全', draft: '草稿', tests: '测试',
  'multi-hop': '多跳', bilingual: '中英', injection: '注入', abstain: '无据'
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function setBusy(button, busy, busyLabel = '处理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  }
}

async function loadDefaultProject() {
  state.project = await fetchJson('/api/project');
  renderProject(state.project);
  await refreshModelStatus();
  window.setInterval(refreshModelStatus, 10000);
}

async function refreshModelStatus() {
  const status = await fetchJson('/api/status').catch(() => ({ online: false, error: '状态检查失败' }));
  const badge = $('#modelStatus');
  if (badge) {
    badge.classList.toggle('offline', !status.online);
    badge.innerHTML = `<span class="status-dot"></span>${status.online ? '本地 Qwen 模型在线' : '规则降级：模型未启动'}`;
    badge.title = status.online ? `${status.model || '本地模型'} · ${status.modelUrl || ''}` : '模型未启动，回答将使用规则降级';
  }
}

function renderProject(project) {
  const meta = project.project;
  $('#projectName').textContent = meta.displayName;
  $('#projectUrl').textContent = meta.url.replace(/^https?:\/\//, '');
  $('#projectDisplayName').textContent = meta.displayName;
  $('#projectLink').href = meta.url;
  $('#workflowIntro').textContent = `系统检索 ${meta.displayName} 的项目资料并组织带证据的回答；外发动作必须人工确认。`;
  $('#licensePill').textContent = meta.license?.spdx || meta.license?.name || '未声明';
  $('#snapshotNote').textContent = meta.snapshotNote || '已载入本地项目资料。';
  $('#docCount').textContent = String(project.documents.length);
  $('#typeSummary').textContent = [...new Set(project.documents.map((doc) => doc.type || 'DOC'))].join(' · ');
  $('#resourceCount').textContent = `${(project.resources || []).length} items`;
  $('#testCount').textContent = project.testCases?.length ? `${project.testCases.length} cases` : project.project.name === 'Requests' ? '32 cases' : '未配置项目测试';
  renderResources(project.resources || []);
  $$('.quick-card').forEach((card) => {
    const displayName = meta.displayName;
    const query = card.dataset.task === 'usage' ? `${displayName} 怎么安装？` : card.dataset.task === 'issue' ? `如何为 ${displayName} 准备 Issue？` : card.dataset.task === 'contribute' ? `${displayName} 如何参与贡献？` : `${displayName} 使用什么许可证？`;
    card.dataset.query = query;
  });
}

function validateProjectForClient(project) {
  if (!project || typeof project !== 'object' || !project.project || !Array.isArray(project.documents) || !project.documents.length) {
    throw new Error('项目 JSON 需要 project 元数据和至少一条 documents 资料');
  }
  if (!project.project.displayName || !/^https?:\/\//i.test(String(project.project.url || ''))) {
    throw new Error('项目 JSON 需要 displayName 和 http(s) 项目地址');
  }
  if (project.documents.length > 100) throw new Error('项目最多支持 100 条资料');
  if (project.documents.some((doc) => !doc || !doc.id || !doc.title)) throw new Error('每条资料都需要 id 和 title');
  if (project.project.license == null) project.project.license = { spdx: '未声明' };
  if (!Array.isArray(project.resources)) project.resources = [];
  return project;
}

function renderResources(resources) {
  $('#resourceList').innerHTML = resources.map((resource) => `
    <div class="resource-item">
      <div class="resource-top"><span class="resource-name">${escapeHtml(resource.name || '')}</span><span class="resource-status">${escapeHtml(resource.status || '')}</span></div>
      <div class="resource-meta">
        <span><b>类型</b><br>${escapeHtml(resource.type || '')} · ${escapeHtml(resource.version || '')}</span>
        <span><b>许可</b><br>${escapeHtml(resource.license || '')}</span>
        <span><b>使用方式</b><br>${escapeHtml(resource.use || '')}</span>
        <span><b>自主内容</b><br>${escapeHtml(resource.teamWork || '')}</span>
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// 证据浏览器：只读展示索引语料与检索证据窗口，不调用模型
// ---------------------------------------------------------------------------

async function loadEvidence(force = false) {
  if (state.evidence && !force) return;
  const data = await fetchJson('/api/evidence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: state.project })
  });
  state.evidence = data;
  const commit = data.project?.snapshotCommit ? `快照 ${String(data.project.snapshotCommit).slice(0, 8)} · ` : '';
  $('#evidenceMeta').textContent = `${commit}${data.documents.length} 条资料 · ${data.totalChunks} 个分块 · 平均 ${data.averageChunkChars} 字符`;
  $('#corpusMeta').textContent = `${data.totalChunks} chunks`;
  const selected = data.documents.find((doc) => doc.id === state.evidenceDocId) || data.documents[0];
  renderEvidenceSources();
  if (selected) renderChunks(selected.id);
}

function renderEvidenceSources() {
  const documents = state.evidence?.documents || [];
  $('#sourceList').innerHTML = documents.map((doc) => `
    <button class="source-item${doc.id === state.evidenceDocId ? ' active' : ''}" data-doc="${escapeHtml(doc.id)}">
      <span class="source-top"><span class="source-type">${escapeHtml(doc.type || 'DOC')}</span><span class="source-name">${escapeHtml(doc.title)}</span></span>
      <span class="source-meta">${doc.chunkCount} 块 · ${doc.chars} 字符${doc.evidencePath ? ` · ${escapeHtml(doc.evidencePath)}` : ''}</span>
      ${doc.source ? `<span class="source-link">${escapeHtml(doc.source)}</span>` : ''}
    </button>`).join('') || '<div class="draft-empty">没有可展示的资料。</div>';
}

function renderChunks(docId) {
  const doc = state.evidence?.documents.find((item) => item.id === docId);
  if (!doc) return;
  state.evidenceDocId = docId;
  renderEvidenceSources();
  $('#chunkTitle').textContent = doc.title;
  $('#chunkMeta').textContent = `${doc.chunkCount} 块 · ${doc.chars} 字符`;
  $('#chunkList').innerHTML = doc.chunks.map((chunk) => `
    <details class="chunk-item">
      <summary><span class="chunk-index">#${chunk.index}</span><span class="chunk-lines">L${chunk.lineStart}–${chunk.lineEnd}</span><span class="chunk-size">${chunk.chars} 字符 · ${chunk.terms} 词项</span></summary>
      <pre>${escapeHtml(chunk.text)}</pre>
    </details>`).join('') || '<div class="draft-empty">该资料没有可展示的分块。</div>';
}

async function runEvidenceQuery(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) { showToast('请输入要复现的问题'); return; }
  const button = $('#evidenceForm button');
  setBusy(button, true, '检索中…');
  $('#evidenceState').textContent = '检索中';
  try {
    const data = await fetchJson('/api/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: state.project, query: trimmed })
    });
    const retrieval = data.retrieval || { hits: [] };
    state.evidence = state.evidence || data;
    $('#evidenceHits').innerHTML = retrieval.hits.length ? retrieval.hits.map((hit, index) => `
      <div class="hit-item">
        <div class="hit-top"><span class="hit-rank">E${index + 1}</span><span class="hit-doc">${escapeHtml(hit.title)}</span>${hit.lowConfidence ? '<span class="hit-flag">最低召回兜底</span>' : ''}<span class="hit-score">分值 ${hit.score}</span><span class="hit-lines">L${hit.lineStart ?? '?'}–${hit.lineEnd ?? '?'}</span></div>
        <div class="hit-meta">${escapeHtml(hit.id)} · ${escapeHtml(hit.type || 'DOC')}${retrieval.injection ? ' · 已识别指令覆盖尝试' : ''}</div>
        <pre>${escapeHtml(hit.evidenceText)}</pre>
      </div>`).join('') : '<div class="draft-empty">没有命中任何分块：该问题可能超出语料范围，需人工确认后再作答。</div>';
    $('#evidenceState').textContent = `${retrieval.intent || 'general'} · 命中 ${retrieval.hits.length} 条`;
  } catch (error) {
    $('#evidenceState').textContent = '失败';
    showToast(`检索失败：${error.message}`);
  } finally {
    setBusy(button, false);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function showView(viewName) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (viewName === 'evidence') loadEvidence().catch((error) => showToast(`证据载入失败：${error.message}`));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function setTrace(items, stateLabel = '已完成') {
  state.trace = items;
  $('#traceState').textContent = stateLabel;
  $('#traceList').innerHTML = items.map((item, index) => `
    <div class="trace-item">
      <div class="trace-icon">${index + 1}</div>
      <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>
    </div>`).join('');
}

function renderVerification(verification) {
  const total = verification.factualClaims || 0;
  const risk = verification.unsupportedClaims || 0;
  const mis = verification.misCitedClaims || 0;
  const formatRisk = verification.formatFlaggedClaims || 0;
  const copySafe = verification.copySafeClaims;
  const problems = [risk ? `${risk} 处具体事实无证据` : '', mis ? `${mis} 处引用错配` : ''].filter(Boolean).join('；');
  const chip = problems
    ? `<span class="verify-chip risk">${problems}</span>`
    : `<span class="verify-chip ok">未发现无依据的具体事实</span>`;
  const formatChip = formatRisk
    ? `<span class="verify-chip risk">${formatRisk} 处路径/URL 格式问题</span>`
    : '';
  const copyChip = Number.isFinite(copySafe)
    ? `<span class="verify-chip ok">可照抄 ${copySafe}/${total}</span>`
    : '';
  const hasFormat = (verification.claims || []).some((claim) => claim.format);
  const filter = hasFormat
    ? '<label class="verify-filter"><input type="checkbox" class="verify-copy-filter"> 只看可照抄</label>'
    : '';
  const label = { grounded: '有据', unsupported: '无据', miscited: '错引', paraphrase: '改写', advice: '建议', meta: '说明' };
  const rows = (verification.claims || []).map((claim) => {
    const errors = claim.format && !claim.format.ok ? (claim.format.errors || []) : [];
    const badge = errors.length
      ? `<span class="format-badge" title="${escapeHtml(errors.map((error) => `${error.type}: ${error.token}`).join('；'))}">格式</span>`
      : '';
    const formatNote = errors.length ? ` · 格式：${errors.map((error) => error.token).join('、')}` : '';
    return `
    <li class="${escapeHtml(claim.state || 'paraphrase')} ${claim.copySafe ? 'copy-safe' : 'not-copy-safe'}">
      <span>${label[claim.state] || '改写'}${badge}</span>
      <p>${escapeHtml(claim.text)}</p>
      <small>${escapeHtml((claim.reason || '') + formatNote)}</small>
    </li>`;
  }).join('');
  return `<div class="verify-block">
    <div class="verify-head"><strong>逐句证据核验</strong>${chip}${formatChip}${copyChip}${filter}<em>${verification.groundedClaims || 0}/${total} 句有据</em></div>
    <details class="verify-details"><summary>查看 ${total} 句核验明细</summary><ul class="verify-list">${rows}</ul></details>
  </div>`;
}

function addMessage(role, text, payload = {}) {
  const history = $('#chatHistory');
  const empty = history.querySelector('.empty-chat');
  if (empty) empty.remove();
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;
  let extra = '';
  if (role === 'agent' && payload.verification) extra += renderVerification(payload.verification);
  if (role === 'agent' && payload.sources?.[0]?.lowConfidence) {
    extra += '<div class="answer-action low-confidence"><strong>未检索到匹配证据</strong>：没有分块达到常规相关度下限，下列候选由最低召回兜底返回，不能作为引用依据，请人工核对后再采用。</div>';
  }
  if (role === 'agent' && payload.sources?.length) {
    extra += `<div class="source-links"><strong>证据</strong>${payload.sources.map((source) => `<details><summary><a href="${escapeHtml(source.source)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)} ↗</a>${source.lowConfidence ? '<span class="tag-flag">最低召回兜底</span>' : ''}</summary><p>${escapeHtml(source.evidence || '')}</p><small>${escapeHtml(source.localPath || '')}${source.lineStart ? ` · 第 ${source.lineStart}-${source.lineEnd} 行` : ''}</small></details>`).join('')}</div>`;
    if (payload.action) extra += `<div class="answer-action">${escapeHtml(payload.action)}</div>`;
  }
  if (role === 'agent') {
    const mode = payload.ai ? `Qwen3-VL-2B-Instruct · 模型生成${payload.repetitionFolded ? ` · 已折叠 ${payload.repetitionFolded} 处重复` : ''}` : payload.model ? `规则兜底 · ${payload.model}` : '规则降级';
    wrapper.innerHTML = `<div><div class="agent-meta"><span>OpenBridge</span><span>${escapeHtml(mode)}</span></div><div class="message-bubble">${escapeHtml(text)}${extra}</div></div>`;
  } else {
    wrapper.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
  }
  history.appendChild(wrapper);
  history.scrollTop = history.scrollHeight;
}

async function askQuestion(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  const submitButton = $('#chatForm button[type="submit"]');
  setBusy(submitButton, true, '检索中…');
  state.lastQuestion = trimmed;
  addMessage('user', trimmed);
  $('#chatInput').value = '';
  setTrace([
    { title: '理解任务', detail: '识别问题意图、动作类型和风险边界' },
    { title: '检索证据', detail: '在项目资料索引中匹配相关条目' },
    { title: '生成回答', detail: '基于证据组织可执行说明' },
    { title: '核验输出', detail: '添加来源、限制和人工确认提示' }
  ], '执行中');
  try {
    const data = await fetchJson('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: trimmed, project: state.project }) });
    state.lastAnswer = data;
    addMessage('agent', data.answer, data);
    setTrace(data.trace || state.trace, data.ai ? '模型已生成' : '规则降级');
    if (!data.guardrail?.sensitive && (data.intent === 'issue' || data.intent === 'draft')) renderDraft(data.draft || buildIssueDraft(trimmed));
    if (data.guardrail?.sensitive) renderDraft('检测到敏感输入：已阻止原文发送给模型，也不生成 Issue 草稿。请先移除凭据或个人信息，再重新提问。');
  } catch (error) {
    addMessage('agent', `暂时无法完成检索：${error.message}\n请检查本地服务后重试。`);
    setTrace([{ title: '请求失败', detail: error.message }], '失败');
    showToast(error.message);
  } finally {
    setBusy(submitButton, false);
  }
}

function renderDraft(text) {
  $('#draftArea').innerHTML = `<pre>${escapeHtml(text)}</pre>`;
  $('#draftArea').dataset.content = text;
}

function issueField(question, label) {
  const match = String(question).match(new RegExp(`${label}\\s*[:：]\\s*([^\\n\\r；;]+)`, 'i'));
  return match ? match[1].trim().replace(/[。；;]+$/, '') : '';
}

function buildIssueDraft(question = state.lastQuestion) {
  // 敏感输入不走草稿生成：草稿会把问题原文拼进去，人工复制时容易把凭据带进公开 Issue。
  if (state.lastAnswer?.guardrail?.sensitive) {
    return '检测到敏感输入：已阻止原文发送给模型，也不生成 Issue 草稿。请先移除凭据或个人信息，再重新提问。';
  }
  const text = String(question || '').trim();
  const requestsVersion = text.match(/(?:Requests\s*(?:项目)?版本|requests==|requests\s+v?)\s*[:：=]?\s*v?([0-9]+(?:\.[0-9]+){1,2})/i)?.[1] || issueField(text, '版本');
  const pythonVersion = text.match(/Python\s*(?:版本)?\s*[:：=]?\s*v?([0-9]+(?:\.[0-9]+){1,2})/i)?.[1] || issueField(text, 'Python版本');
  const operatingSystem = issueField(text, '操作系统') || text.match(/\b(Windows\s*(?:10|11)|Ubuntu\s*[0-9.]*|macOS(?:\s*[0-9.]+)?|Linux)\b/i)?.[1] || '';
  const actual = issueField(text, '实际结果');
  const expected = issueField(text, '预期结果');
  const reproduction = issueField(text, '执行命令') || issueField(text, '最小复现') || text;
  const projectName = state.project?.project?.displayName || '项目';
  const title = issueField(text, '标题') || (/安装|pip|依赖/.test(text) ? `${projectName} 安装问题` : `${projectName} Issue：${text.split(/\r?\n/)[0].slice(0, 60)}`);
  return `标题：${title}\n\n环境\n- ${projectName} 版本：${requestsVersion || '［待补充］'}\n- 操作系统：${operatingSystem || '［待补充］'}\n- Python 版本：${pythonVersion || '［待补充］'}\n\n最小复现\n${reproduction}\n\n实际结果\n${actual || '［请粘贴脱敏后的实际结果］'}\n\n预期结果\n${expected || '［请说明预期行为］'}\n\n隐私检查\n提交前确认已删除访问令牌、Cookie、个人信息和生产日志。\n\n来源\nOpenBridge 根据 ${projectName} 项目资料生成，需人工核验后再提交。`;
}

function buildTestChecklist() {
  const projectName = state.project?.project?.displayName || '当前项目';
  const question = String(state.lastQuestion || '').trim();
  const sources = (state.lastAnswer?.sources || []).map((source) => source.title).filter(Boolean);
  const topic = question.replace(/[？?。！!]+$/g, '') || `${projectName} 基础功能`;
  let checks;

  if (/timeout|超时/i.test(question)) {
    checks = [
      '从引用资料确认 timeout 的调用位置和适用请求方法；资料未明确的部分先标记待核实',
      '按确认后的调用方式，对可控测试地址发起一次正常请求并记录状态码与耗时',
      '在可控的延迟响应场景验证超时行为，记录实际异常、耗时和请求参数',
      '对照正常响应与超时结果，检查实际表现是否符合项目文档和预期',
      '记录项目版本、运行环境、timeout 取值及复现步骤，不在日志中保留凭据'
    ];
  } else if (/安装|install|pip/i.test(question)) {
    checks = [
      '按引用资料中的命令安装，并记录项目和运行时版本',
      '在干净环境重复安装，确认依赖解析和安装结果',
      '导入项目并运行一个最小示例，记录实际输出或错误',
      '将实际结果与文档中的预期步骤对照，并保留可复现命令'
    ];
  } else if (/issue|问题单|复现|日志/i.test(question)) {
    checks = [
      '核对 Issue 模板要求的版本、环境、最小复现、实际结果和预期结果',
      '在干净环境按最小复现步骤重新运行，确认问题可以稳定复现',
      '检查日志和示例已移除令牌、Cookie、个人信息及生产数据',
      '确认每项结论都能由复现结果或引用资料支持，再交由人工复核'
    ];
  } else if (/测试|test|pytest/i.test(question)) {
    checks = [
      '按引用的贡献或测试文档确认测试文件位置和运行命令',
      '先运行相关测试记录基线结果，再运行完整测试套件',
      '为目标行为准备成功路径、边界条件和失败路径用例',
      '记录失败输出、环境与版本，并确认新增测试能复现目标问题'
    ];
  } else {
    checks = [
      `根据引用资料为“${topic}”确定一个最小可复现操作和预期结果`,
      '先运行正常路径，再覆盖与该功能相关的边界条件和失败路径',
      '记录输入、项目版本、运行环境、实际输出和错误信息',
      '将实际结果与引用资料及预期行为对照；证据不足处标记待核实'
    ];
  }

  const checklist = checks.map((item) => `[ ] ${item}`).join('\n');
  const sourceNote = sources.length ? `\n\n依据资料：${[...new Set(sources)].join('；')}` : '\n\n依据资料：尚无上一次问答的来源；请先提问并核对回答证据。';
  return `测试清单：${projectName} · ${topic}\n\n${checklist}${sourceNote}\n\n生成后请按实际项目文档和测试环境核对，不会自动运行测试。`;
}

async function runValidation() {
  const button = $('#runValidation');
  setBusy(button, true, '运行中…');
  $('#validationState').textContent = '运行中';
  try {
    const data = await fetchJson('/api/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: state.project }) });
    state.tests = data.results;
    $('#validationState').textContent = data.configured === false ? '未配置' : '已完成';
    $('#scoreValue').textContent = data.passRate == null ? '--' : `${data.passRate}%`;
    const degree = Math.round((data.passRate || 0) * 3.6);
    $('#scoreRing').style.background = `conic-gradient(var(--blue) 0deg, var(--blue) ${degree}deg, #e9eef6 ${degree}deg)`;
    $('#citationRate').textContent = data.citationRate == null ? '待测' : `${data.citationRate}%`;
    $('#testCount').textContent = `${data.total || 0} cases · 护栏 ${data.guardrailSummary?.total || 0}${data.skipped ? ` · 合并 ${data.skipped}` : ''}`;
    const percentOf = (summary) => (summary?.total ? Math.round((summary.passed / summary.total) * 100) : null);
    $('#validationMetrics').innerHTML = data.configured === false ? '<span class="metric-warning">该项目没有提供 testCases，无法进行项目专属验证。</span>' : [
      [data.top1Accuracy ?? data.citationPrecision, '首位命中率'],
      [data.citationRecall, '来源召回率'],
      [data.evidenceCoverage, '证据覆盖率'],
      [data.guardrailSummary?.passRate, '护栏通过率'],
      [percentOf(data.injectionSummary), `提示注入 ${data.injectionSummary?.passed ?? 0}/${data.injectionSummary?.total ?? 0}`],
      [percentOf(data.abstainSummary), `无据不答 ${data.abstainSummary?.passed ?? 0}/${data.abstainSummary?.total ?? 0}`]
    ].map(([value, label]) => `<span><b>${value == null ? '--' : `${value}%`}</b><small>${escapeHtml(label)}</small></span>`).join('');
    $('#categoryStrip').innerHTML = [
      ...(data.categorySummary || []).map((item) => `<span class="category-chip${item.passed === item.total ? ' ok' : ' warn'}">${escapeHtml(CATEGORY_LABEL[item.category] || item.category)} ${item.passed}/${item.total}</span>`),
      ...(data.abstainSelfCheck?.total ? [`<span class="category-chip note" title="用合成答案对逐句核验做自检：命中说明核验器拦住了该条合成事实">核验自检 ${data.abstainSelfCheck.caught}/${data.abstainSelfCheck.total}</span>`] : []),
      ...(data.retired?.length ? [`<span class="category-chip note" title="${escapeHtml(data.retired.map((item) => `${item.id}：${item.reason}`).join('；'))}">已合并 ${data.retired.map((item) => escapeHtml(item.id)).join('、')}</span>`] : [])
    ].join('');
    $('#resultsBody').innerHTML = data.results.length ? data.results.map((result) => {
      const expectedSources = (result.expectedSources || []).join(', ');
      const evidenceHits = result.evidenceKeywordHits ?? result.keywordHits;
      const forbidden = (result.mustNotContain || []).join('、');
      let keywordCell;
      let citationCell;
      let verdict;
      if (result.type === 'abstain') {
        // 负面用例：说明“通过”检查的是“没有编造”，而不是“答对了”。
        keywordCell = forbidden ? `不得出现：${forbidden}` : '—';
        citationCell = `无预期来源 · 语料不含该事实`;
        verdict = result.pass ? '通过 · 未编造' : '需修正 · 出现编造';
      } else if (result.type === 'injection') {
        keywordCell = result.keywordTotal ? `${evidenceHits}/${result.keywordTotal}` : '—';
        citationCell = `${result.citation ? '命中' : '缺失'} · ${expectedSources} · 注入已识别`;
        verdict = result.pass ? '通过' : '需修正';
      } else {
        keywordCell = result.keywordTotal ? `${evidenceHits}/${result.keywordTotal}` : '—';
        citationCell = `${result.citation ? '命中' : '缺失'} · ${expectedSources}`;
        verdict = result.pass ? '通过' : '需修正';
      }
      const tip = result.check || `期望：${expectedSources}`;
      return `<tr title="${escapeHtml(tip)}"><td>${escapeHtml(result.id)}</td><td>${escapeHtml(CATEGORY_LABEL[result.category] || result.category || '')}</td><td>${escapeHtml(result.query)}</td><td>${escapeHtml(citationCell)}</td><td>${escapeHtml(keywordCell)}</td><td class="${result.pass ? 'result-pass' : 'result-fail'}">${escapeHtml(verdict)}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="table-empty">当前项目没有可运行的测试用例。</td></tr>';
    showToast(`测试完成：${data.passed}/${data.total} 通过`);
  } catch (error) {
    $('#validationState').textContent = '失败';
    showToast(`测试失败：${error.message}`);
  } finally {
    setBusy(button, false);
  }
}

function exportEvidence() {
  const sensitive = Boolean(state.lastAnswer?.guardrail?.sensitive);
  const payload = {
    exportedAt: new Date().toISOString(),
    product: 'OpenBridge 0.4.1',
    project: state.project?.project?.displayName,
    question: sensitive ? '[已省略：问题包含敏感信息]' : state.lastQuestion || null,
    answer: sensitive ? null : state.lastAnswer || null,
    tests: state.tests,
    note: sensitive ? '敏感问题未写入导出文件；提交前请核验项目链接和团队信息。' : '该证据包由浏览器本地生成，提交前请核验项目链接和团队信息。'
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = 'openbridge-evidence.json';
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  showToast('证据包已导出');
}

function importProject(file) {
  if (file.size > 1024 * 1024) { showToast('项目 JSON 不能超过 1 MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.project = validateProjectForClient(JSON.parse(reader.result));
      renderProject(state.project);
      state.lastQuestion = '';
      state.lastAnswer = null;
      state.tests = [];
      state.evidence = null;
      state.evidenceDocId = null;
      $('#validationState').textContent = '尚未运行';
      $('#scoreValue').textContent = '--';
      $('#scoreRing').style.background = 'conic-gradient(var(--blue) 0deg, var(--blue) 0deg, #e9eef6 0deg)';
      $('#citationRate').textContent = '待测';
      $('#validationMetrics').innerHTML = '<span><b>--</b><small>首位命中率</small></span><span><b>--</b><small>来源召回率</small></span><span><b>--</b><small>证据覆盖率</small></span><span><b>--</b><small>护栏通过率</small></span><span><b>--</b><small>提示注入</small></span><span><b>--</b><small>无据不答</small></span>';
      $('#categoryStrip').innerHTML = '';
      $('#resultsBody').innerHTML = '<tr><td colspan="6" class="table-empty">点击“运行全部测试”查看结果。</td></tr>';
      $('#evidenceMeta').textContent = '尚未载入';
      $('#evidenceState').textContent = '等待查询';
      $('#evidenceHits').innerHTML = '<div class="draft-empty">输入问题后，这里显示命中的资料、BM25 分值、坐标行号与证据窗口原文。该检索不调用模型，可在无 GPU 时复现。</div>';
      $('#sourceList').innerHTML = '<div class="draft-empty">载入后显示每条资料的来源、分块数和字符数。</div>';
      $('#chunkList').innerHTML = '<div class="draft-empty">选择左侧资料，查看每个分块的行号范围与原文。</div>';
      $('#chunkTitle').textContent = '分块明细';
      $('#chunkMeta').textContent = '选择左侧资料';
      $('#chatHistory').innerHTML = '<div class="empty-chat"><div class="empty-icon">✦</div><strong>先问一个问题</strong><span>例如：贡献代码前要做哪些准备？</span></div>';
      $('#draftArea').innerHTML = '<div class="draft-empty">从上面的问答中生成 Issue 草稿，或点击下方模板。</div>';
      showToast('项目资料已载入，问答和验证将使用该项目');
    } catch (error) {
      showToast(error.message || 'JSON 格式无法读取');
    }
  };
  reader.readAsText(file, 'utf-8');
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view]');
  const target = event.target.closest('[data-view-target]');
  if (nav) showView(nav.dataset.view);
  if (target) showView(target.dataset.viewTarget);
  const quick = event.target.closest('.quick-card');
  if (quick) { showView('workbench'); setTimeout(() => askQuestion(quick.dataset.query), 80); }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('.verify-copy-filter')) return;
  const list = event.target.closest('.verify-block')?.querySelector('.verify-list');
  if (list) list.classList.toggle('copy-filter-on', event.target.checked);
});

$('#chatForm').addEventListener('submit', (event) => { event.preventDefault(); askQuestion($('#chatInput').value); });
$('#generateIssue').addEventListener('click', () => {
  const draft = buildIssueDraft();
  renderDraft(draft);
  const blocked = /^检测到敏感输入/.test(draft);
  showToast(blocked ? '敏感输入：已阻止生成 Issue 草稿' : 'Issue 草稿已生成');
});
$('#generateTest').addEventListener('click', () => { renderDraft(buildTestChecklist()); showToast('测试清单已生成'); });
$('#runValidation').addEventListener('click', runValidation);
$('#exportEvidence').addEventListener('click', exportEvidence);
$('#evidenceForm').addEventListener('submit', (event) => { event.preventDefault(); runEvidenceQuery($('#evidenceQuery').value); });
$('#sourceList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-doc]');
  if (item) renderChunks(item.dataset.doc);
});
$('#projectFile').addEventListener('change', (event) => { const [file] = event.target.files; if (file) importProject(file); event.target.value = ''; });

loadDefaultProject().catch(() => showToast('默认项目资料加载失败，请检查本地服务')); 
