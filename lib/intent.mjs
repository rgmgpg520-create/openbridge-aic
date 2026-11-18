// Question intent used for retrieval priors and for routing answers.
// Deliberately small and transparent: the classification only selects a
// preferred document type; it does not produce the answer.

export function detectIntent(question) {
  const q = String(question).toLowerCase();
  if (/生成.*issue|issue.*模板|生成.*草稿|草稿.*模板/.test(q)) return 'draft';
  if (/许可|license|apache|再分发|署名|商用|闭源|出售|变卖|卖|版权|专利/.test(q)) return 'license';
  if (/安全|\btokens?\b|令牌|密钥|隐私|漏洞/.test(q)) return 'security';
  if (/测试文件|测试在哪|test file|test suite|pytest|测试用例/.test(q)) return 'tests';
  if (/\bissues?\b|问题单|复现|日志/.test(q)) return 'issue';
  if (/贡献|\bprs?\b|pull request|分支|测试/.test(q)) return 'contribute';
  if (/安装|\bpip\d?\b|怎么用|\bget\b|请求|\btimeouts?\b|\bsessions?\b/.test(q)) return 'usage';
  return 'general';
}
