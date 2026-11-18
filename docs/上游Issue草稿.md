# 向 Requests 上游提交 Issue 的草稿与提交记录

> 本文件是 OpenBridge 团队在使用 Requests 固定快照（提交 `611c6162`，2026-09-21）过程中发现的**一个真实、可核对的文档缺口**，已由队员用本人账号提交到 `psf/requests` 上游。
> 下面的第一至第四节是**提交前的草稿原文**，保留以便对照；第五节是提交前必读（已逐条执行）；第六节记录实际提交信息与提交后跟进。

## 提交状态（2026-10-27 00:00 北京时间核对）

| 项目 | 内容 |
|---|---|
| 编号 | **#7635** |
| 链接 | https://github.com/psf/requests/issues/7635 |
| 标题 | `Docs: link security vulnerability reports from CONTRIBUTING.md` |
| 提交时间 | 2026-10-26 15:58 UTC（北京时间 2026-10-26 23:58） |
| 提交账号 | `rgmgpg520-create`（队员本人账号） |
| 当前状态 | **open**，0 条回复 |

三点说明，避免与草稿混淆：

1. 实际提交的**标题与措辞由提交者本人用自己的话改写**，与下面草稿不完全一致；草稿建议的改法（在 `CONTRIBUTING.md` 补一句指向 `SECURITY.md` 的提示）在提交版中保留。
2. 提交版遵守 Requests 的 `.github/AI_POLICY.md`：由人类理解并负责，没有 AI 署名，也没有 `Co-authored-by`。
3. 团队**没有** fork 或改动 Requests 上游任何文件，本次上游动作只有这一个 Issue；本仓库内的改动只是把"草稿"更新为"已提交"并回填链接。

## 一、发现的问题（事实，已核对）

`.github/CONTRIBUTING.md` 的 "Good Bug Reports" 一节指导新手：报告异常时贴**完整 traceback**、附**可立即运行的小代码样例**；但全文没有任何一句提醒——**安全漏洞不应走公开 issue**。

而 `.github/SECURITY.md` 明确要求：

- 通过私密的 **draft Security Advisory** 报告：`https://github.com/psf/requests/security/advisories/new`；
- 提供"发现漏洞所用的代码 + 最短复现代码"；
- **"Please do not disclose this to anyone else."**（不要向任何其他人披露）。

两份文件之间缺少一个从 CONTRIBUTING → SECURITY 的指引。直接阅读贡献指南（或从 docs 入口进入）的新手，可能把带复现代码的漏洞细节发到公开 issue，与 SECURITY.md 的私密要求相冲突。

## 二、去重核查（2026-10-25 已做）

- 用 GitHub Search API 检索 `repo:psf/requests is:issue security policy contributing`、`vulnerability disclosure advisory`：开放 issue 中**未发现**相同建议。
- 已核对上游 `main` 分支的 `.github/CONTRIBUTING.md` 与 `.github/SECURITY.md`，与固定快照一致，缺口仍然存在。

## 三、需要在 Issue 中诚实说明的反方观点

GitHub 在仓库的 "New Issue" 页面会**自动检测并提示** Security Policy 入口，所以这个缺口并非所有用户都会遇到。Issue 里应主动说明这一点，把建议定位为"为直接阅读贡献指南的人补一道防线（defense in depth）"，而不是声称现有流程完全缺失。这是一个**小的文档增强建议**，维护者可能采纳，也可能认为 GitHub 已自动处理而关闭——这是正常的，不影响"提交了一个真实、有据、可核对的上游 Issue"这一事实。

## 四、英文 Issue 正文（参考，请用自己的话改写）

**Title**

```
Docs: CONTRIBUTING.md does not point reporters to the private security disclosure channel
```

**Body**

```
### Summary
`.github/CONTRIBUTING.md` explains how to file good bug reports and pull requests,
but it never mentions security vulnerabilities. A first-time contributor who follows
"Good Bug Reports" for a suspected security issue could post a complete traceback and
minimal reproduction code in a public issue, while `.github/SECURITY.md` asks reporters
to use a private draft Security Advisory and "Please do not disclose this to anyone else."

### Details
- In `.github/CONTRIBUTING.md`, "Good Bug Reports" asks for the *complete* traceback and
  a small, immediately-runnable code sample, with no note that security-sensitive reports
  should stay private.
- `.github/SECURITY.md` asks reporters to open a draft Security Advisory
  (https://github.com/psf/requests/security/advisories/new), include the code used to find
  the problem plus the shortest code needed to reproduce it, and not disclose it publicly.
- There is currently no cross-reference from CONTRIBUTING.md toward SECURITY.md.

I understand GitHub already surfaces a link to the security policy on the "New Issue"
page, so this is not a gap for everyone. A one-line pointer in CONTRIBUTING.md would
additionally cover people who read the contributing guide directly (e.g. via the docs),
and would match the private-first guidance in SECURITY.md.

### Suggested change (optional, happy to adjust)
Add a short note near the top of `.github/CONTRIBUTING.md`, for example:

> **Found a security vulnerability?** Please do not open a public issue. Follow
> [SECURITY.md](/.github/SECURITY.md) and open a private
> [draft Security Advisory](https://github.com/psf/requests/security/advisories/new) instead.

I'd be happy to open a PR with this change if it would be welcome.

### Checklist
- [x] Searched open and closed issues; did not find an existing report
- [x] Confirmed against `.github/CONTRIBUTING.md` and `.github/SECURITY.md` on `main`

Thanks!
```

## 五、提交前必读（提交前已逐条执行，保留原文备查）

1. **本人核实**：亲自打开下面两个链接，确认问题仍然存在，再提交：
   - https://github.com/psf/requests/blob/main/.github/CONTRIBUTING.md
   - https://github.com/psf/requests/blob/main/.github/SECURITY.md
2. **遵守 Requests 的 AI 政策**：仓库 `.github/AI_POLICY.md` 要求每个贡献由人类完全理解并负责，禁止 LLM 生成的低质量内容、禁止 AI 署名。Issue 虽非 PR，但同样请**用自己的话改写**、确保你能回答维护者的追问，不要出现"AI 生成"痕迹或任何 `Co-authored-by`。
3. **不要夸大**：保持"建议增强"的语气，承认 GitHub 已自动提示；维护者回复后礼貌跟进，若被关闭不要反复提交。
4. **提交入口**：登录自己的 GitHub 账号 → 进入 https://github.com/psf/requests/issues/new 粘贴标题与正文 → 提交。
5. **提交后**：把 Issue 链接填回技术报告"开放成果"部分、报名表"作品其他材料链接"，并在本文件顶部记录提交时间和编号。
6. 若维护者表示欢迎，可按其 CONTRIBUTING 流程（fork、改 `.github/CONTRIBUTING.md`、pre-commit、发 PR 到 `main`）再提交一个对应的小 PR；若维护者认为不需要，以 Issue 本身作为上游贡献证据即可。

## 六、提交后跟进

- **已回填链接**：`README.md`（“开放成果与公开仓库”）、`提交清单.md`、`docs/公开仓库推送指南.md`、`docs/成果链接提交说明.md`、`docs/答辩讲稿.md`、`docs/需求分析-真实提问抽样.md`，以及技术报告 `scripts/build-report-v3.py` 的“六、3 社区贡献与复用”“八、1 项目总结”“八、2 后续计划”“九、3 测试记录与人工复核”四处正文；`dist/OpenBridge_技术报告.pdf` / `.docx` 已同步重出。
- **跟进原则**：维护者回复后礼貌跟进，一次回复只推进一件事；若被关闭或表示 GitHub 已自动提示、无需改动，就以本 Issue 作为上游贡献证据，不重复提交。
- **若维护者表示欢迎**：按其 CONTRIBUTING 流程 fork、修改 `.github/CONTRIBUTING.md`、跑 pre-commit、向 `main` 发 PR；PR 同样遵守 `.github/AI_POLICY.md`，不加 AI 署名。
- **记录维护**：状态变化（收到回复、被关闭、转为 PR）时更新本文顶部的"提交状态"表与 `CHANGELOG.md`。
