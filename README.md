# OpenBridge 开源桥

OpenBridge 是面向开源新手的可核对知识助手：把开源知识查询变成一份可核对的**逐句证据账本**。系统固定 Requests 官方仓库提交，按块检索真实维护文档、源码和测试，调用本地 Qwen3-VL-2B-Instruct 生成带证据的中文答复；每句回答都有“有据 / 语义改写 / 无据”、证据行号和“能不能照抄”标记，只有“有据且格式通过”的句子才进入可照抄区。另含敏感信息护栏、离线评测与可人工复核的 Issue 草稿，系统不会自动向上游提交内容。

> 普通 RAG 给一段话和文末链接；OpenBridge 从知识查询到 Issue 草稿，每一步都有证据。

## 当前实现

- Requests 快照：commit `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60`，来源见 `resources/requests/SOURCE.md`。
- 检索：`lib/retrieval.mjs` 把每条资料切成约 1.1k 字符、带真实行号的块，用 BM25（中文二元组 + 英文词）打分，取每条资料的最高分块作为证据，最多返回 3 条；中文摘要与标签作为元数据通道参与匹配。
- 生成：连接本机 OpenAI-compatible Qwen 服务，提示词只允许模型依据检索证据作答，并写出来自证据的文件名、函数名或命令。
- 核验：`lib/verify.mjs` 按句判断证据支撑，输出 `grounded / paraphrase / unsupported` 三种状态；含数字、路径或标识符却找不到证据的句子被标为风险，界面会红字提示。规则只在模型不可用或输出违反许可证事实时兜底。
- 证据浏览：界面第 2 页「证据浏览器」只读展示固定快照的 7 条资料、149 个分块的真实起止行号与原文，并可输入任意问题复现命中的资料、BM25 分值和证据窗口；该页不调用模型，无 GPU 也能复核引用链。
- 护栏：敏感信息提示、提示注入识别、风险问题私密报告提醒，外发动作必须人工确认。
- 评测：32 条开发检索用例（含多跳、中英混问、提示注入、无证据四类新增用例）、8 条护栏用例、12 条模型对照问题，另有 55 条留出问题（修复后作为回归集：R@1 73%、R@3 98%）与 20 条修复后新写、只评估一次的独立验证问题（R@1 70%、R@3 95%）。

## 运行方式

**最快的方式：双击 `使用说明\启动.bat`。** 脚本以「自己的上一级目录」为项目根目录，不认盘符，换目录、换电脑、放 U 盘或中文/带空格的路径都能直接跑；它会自动寻找 Node.js、带 `torch` 的 Python 和 Qwen 权重，找不到模型时降级为「仅网页」并说明原因。只想看界面可双击 `使用说明\启动-仅网页.bat`，先确认环境可双击 `使用说明\诊断.bat`。安装、部署、使用与排查说明见 `使用说明\运行说明.md`。

唯一硬性依赖是 Node.js 18+。真实模型演示另需带 CUDA 的 Python 环境（本项目开发与演示使用 torch 2.11.0+cu128、transformers 5.1.0）和本机 Qwen 权重：

```powershell
cd "换成你的项目文件夹"
& "你的环境\python.exe" model\serve.py
```

没有现成环境时，在项目文件夹内从零创建虚拟环境（`.venv/` 已被 `.gitignore` 忽略，**不随提交包分发**，换机器后必须自己创建；缺少 Python 3.11 时先安装 3.11，`py -3.11` 才会生效）：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r model\requirements.txt
.\.venv\Scripts\python.exe model\serve.py
```

完整环境说明见 `docs\运行说明.md`，最快上手见 `使用说明\运行说明.md`。模型目录默认读取 `<项目>\..\qwen\Qwen\Qwen3-VL-2B-Instruct`（与模型服务所在位置无关，可用 `OPENBRIDGE_MODEL_DIR` 覆盖）。

模型服务显示 `OpenBridge Qwen service at http://127.0.0.1:8080` 后，在项目文件夹内打开第二个 PowerShell：

```powershell
node server.mjs
```

浏览器打开 `http://127.0.0.1:4173`。如果 Node 安装已加入 PATH，也可执行 `node server.mjs`。

## 模型依赖

模型权重不随参赛成果包分发。默认读取 `<项目>\..\qwen\Qwen\Qwen3-VL-2B-Instruct`（可用 `OPENBRIDGE_MODEL_DIR` 指到任意位置）。Python 3.11 环境依赖清单在 `model\requirements.txt`；安装和模型许可以 `docs\模型安装与许可.md` 为准。也可设置 `OPENBRIDGE_MODEL_URL` 连接其他本机 OpenAI-compatible 推理服务。

本地模型未启动时网页会显示“规则降级”，此状态便于查看界面和规则基线，但不能作为 AI 模型验证结果。提交演示视频前，必须启动模型并确认 `/api/status` 返回 `online: true`。

左侧“导入项目 JSON”会让后续问答与评测都使用导入资料。字段说明见 `docs\项目JSON格式.md`；数据会发送给本机 OpenBridge 服务，并按 `OPENBRIDGE_MODEL_URL` 发送给所配置的推理服务，导入前应脱敏。

## 评测

```powershell
# 12 条问题的“仅模型 vs 项目 RAG”对照，需要模型在线
node scripts\benchmark.mjs

# 55 条留出问题的纯检索评测，不需要模型
# 换一套题：$env:OPENBRIDGE_QUESTIONS='holdout-questions-v2.json'（20 条独立验证集）
node scripts\eval-retrieval.mjs

# 32 条开发用例 + 8 条护栏用例（网页“运行全部测试”或调用 /api/validate）
node scripts\smoke-test.mjs
```

`benchmark.mjs` 逐条请求“仅模型”和“项目 RAG”，记录真实生成文本、来源、回答模式、延迟、词项覆盖和逐句核验状态；模型离线时脚本直接失败，不会生成虚构分数。`eval-retrieval.mjs` 报告 Recall@1、Recall@3 和 MRR，用来检查检索是否只对开发用例有效。32 条开发用例的统计口径见下：首位命中率与证据覆盖率在 28 条检索型用例上计算，4 条“无证据”用例按定义没有预期来源，单独按“语料与答案都不含该事实”判定。

## 目录

```
使用说明/       评委入口：启动.bat、启动-仅网页.bat、诊断.bat、start-openbridge.ps1、运行说明.md
lib/            检索、核验、意图与文本工具（无第三方依赖）
scripts/        benchmark、留出集评测、冒烟测试、盲评、工具脚本
data/           项目资料索引、开发用例、护栏用例
resources/      Requests 固定快照与原始 LICENSE
benchmark/      12 条对照问题、55 条回归留出问题、20 条独立验证问题（结果写入 results/）
results/        最新对照、留出、人工复核结果（latest-results.json 等）
dist/           单文件离线演示页（双击即可在浏览器打开）
model/          Qwen 本地服务适配（权重不随包分发）
docs/           运行、格式、许可、盲评、错误分析与需求记录
```

## 开放成果与公开仓库

- 公开仓库：Gitee（主）`https://gitee.com/ccccccchenfuyao/openbridge-aic`（保留完整 Git 提交历史与 MIT LICENSE，2026-10-26 用未登录访问验证可访问）；GitHub（备）暂未创建，Gitee 为唯一公开仓库。
- 演示视频：`OpenBridge-演示视频.mp4` 以附件形式挂在 Gitee 发行版，入口 `https://gitee.com/ccccccchenfuyao/openbridge-aic/releases`。视频原片不进入 Git 历史（`.gitignore` 排除 `*.mp4`，单文件约 70MB，避免仓库臃肿），Gitee 代码页也不支持在线播放 mp4，需在发行版页下载后本地播放。
- 无需 GPU 的评审入口：直接用浏览器打开 `dist/OpenBridge-离线演示.html`，可查看 12 题的真实回答、来源与逐句核验，不依赖 Node、模型或显卡。
- A/B 盲评：`node scripts/ab-blind-review.mjs`，组织与判定说明见 `docs/试用盲评说明.md`；真实试用者结果写入 `results/ab-reviews`。
- 上游反馈：已向 Requests 提交文档缺口 Issue **[#7635](https://github.com/psf/requests/issues/7635)**（`Docs: link security vulnerability reports from CONTRIBUTING.md`，2026-10-26 由队员本人账号提交，记录时状态 open）。系统本身仍不会自动向上游提交任何内容。

## 开源与权利边界

OpenBridge 自有代码按 MIT 许可。Requests 上游文件带有原始 LICENSE 和来源快照说明，按其 Apache-2.0 条款提供。Qwen 模型权重不随项目分发；使用者需从官方模型仓库获取，并自行核对当期模型卡、许可证和适用条款。第三方资源的来源与许可说明见 `resources\requests\SOURCE.md` 与 `docs\模型安装与许可.md`。
