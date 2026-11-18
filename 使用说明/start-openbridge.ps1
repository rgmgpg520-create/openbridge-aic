<#
  OpenBridge 一键启动 / 环境自检（Windows）

  本文件在 <项目>\使用说明\ 里，向上找含 server.mjs 的目录作为项目根，
  任何地方都不写死 D:\OpenBridge_AIC。所以把整个项目复制到桌面、U 盘、
  E:\评审\xxx、OneDrive 目录，甚至路径里带空格或中文，双击 启动.bat 都能跑。

  用法（一般不用手敲，双击本文件夹里的 启动.bat / 启动-仅网页.bat / 诊断.bat 即可）：
    powershell -NoProfile -ExecutionPolicy Bypass -File start-openbridge.ps1
    ... -WebOnly     只启动网页工作台，不加载模型（没有 GPU / 没装 Python 时用）
    ... -NoBrowser   启动后不自动打开浏览器
    ... -Diagnose    只做环境自检，不启动任何服务

  自动探测顺序（找不到就降级，不会卡住）：
    Node.js   PATH -> Program Files / LOCALAPPDATA / scoop / D:\node-v20...
    Python    OPENBRIDGE_PYTHON -> .venv -> 当前 conda -> 常见 anaconda 环境 -> py -3.11 -> PATH
    模型权重  OPENBRIDGE_MODEL_DIR -> 项目内 model\Qwen3-VL-2B-Instruct -> 上级 qwen\Qwen\...
              -> D:\ / C:\ / 用户目录 -> Hugging Face 本地缓存
#>

[CmdletBinding()]
param(
  [switch]$WebOnly,
  [switch]$NoBrowser,
  [switch]$Diagnose
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 输出
function Write-Title { param($Text) Write-Host ''; Write-Host ('== ' + $Text) -ForegroundColor Cyan }
function Write-Ok    { param($Text) Write-Host ('  [OK] ' + $Text) -ForegroundColor Green }
function Write-Warn  { param($Text) Write-Host ('  [!]  ' + $Text) -ForegroundColor Yellow }
function Write-Err   { param($Text) Write-Host ('  [X]  ' + $Text) -ForegroundColor Red }
function Write-Note  { param($Text) Write-Host ('       ' + $Text) -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 项目根目录
# 本脚本在 <项目>\使用说明\ 里：从脚本所在目录逐级向上找含 server.mjs 的目录。
# 这样整个“使用说明”文件夹可以放在项目任意层级，换盘符、换电脑都不受影响。
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $scriptDir
$guard = 0
while ($Root -and $guard -lt 6 -and -not (Test-Path (Join-Path $Root 'server.mjs'))) {
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { $Root = ''; break }
  $Root = $parent
  $guard++
}
if (-not $Root -or -not (Test-Path (Join-Path $Root 'server.mjs'))) { $Root = (Get-Location).Path }
if (-not (Test-Path (Join-Path $Root 'server.mjs'))) {
  Write-Err '定位项目目录失败：找不到 server.mjs。'
  Write-Note '请把“使用说明”文件夹留在项目里（与 server.mjs 所在目录相邻），或先 cd 到项目根目录再运行。'
  exit 1
}

# ---------------------------------------------------------------- 端口
$webPort = 4173
if ($env:PORT) { $parsed = 0; if ([int]::TryParse($env:PORT, [ref]$parsed)) { $webPort = $parsed } }
$modelPort = 8080
if ($env:MODEL_PORT) { $parsed = 0; if ([int]::TryParse($env:MODEL_PORT, [ref]$parsed)) { $modelPort = $parsed } }

$webUrl    = 'http://127.0.0.1:' + $webPort + '/'
$statusUrl = 'http://127.0.0.1:' + $webPort + '/api/status'
$modelUrl  = 'http://127.0.0.1:' + $modelPort + '/v1/models'

# 只改了 MODEL_PORT 时，让网页也知道新地址（server.mjs 默认连 8080）。
if ($modelPort -ne 8080 -and -not $env:OPENBRIDGE_MODEL_URL) {
  $env:OPENBRIDGE_MODEL_URL = 'http://127.0.0.1:' + $modelPort
}

# ---------------------------------------------------------------- 探测工具
function Test-Port {
  param([int]$Port, [string]$Target = '127.0.0.1')
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Target, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-Http {
  param([string]$Url, [int]$TimeoutSec = 2)
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Wait-Service {
  param([string]$Url, [int]$TimeoutSec, [string]$Label)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $started = Get-Date
  while ((Get-Date) -lt $deadline) {
    if (Test-Http -Url $Url -TimeoutSec 2) { return $true }
    Start-Sleep -Seconds 2
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    if ($elapsed % 10 -lt 2) { Write-Host ('.') -NoNewline -ForegroundColor DarkGray }
  }
  Write-Host ''
  return $false
}

function Find-Node {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  if ($env:ProgramFiles)        { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA)        { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  if ($env:USERPROFILE)         { $candidates += (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe') }
  $candidates += 'D:\node-v20.0.0-win-x64\node.exe'
  $candidates += 'C:\nodejs\node.exe'
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path }
  }
  return $null
}

function Get-PythonInfo {
  param([string]$Exe, [string[]]$PreArgs = @())
  # 这里刻意不用引号：Windows PowerShell 5.1 会吃掉原生命令参数里的双引号，
  # 写成 print("%s") 会让 Python 收到 print(%s) 直接报语法错误。
  $code = 'import sys, torch, transformers; print(sys.version.split()[0], torch.__version__, transformers.__version__)'
  $out = & $Exe @PreArgs -c $code 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $line = [string]($out | Select-Object -Last 1)
  $parts = @($line.Trim() -split '\s+')
  if ($parts.Count -lt 3) { return $null }
  return [pscustomobject]@{
    Exe = $Exe; Pre = $PreArgs; Python = $parts[0]; Torch = $parts[1]; Transformers = $parts[2]
  }
}

function Find-Python {
  $candidates = @()
  if ($env:OPENBRIDGE_PYTHON) { $candidates += [pscustomobject]@{ Exe = $env:OPENBRIDGE_PYTHON; Pre = @() } }
  $candidates += [pscustomobject]@{ Exe = (Join-Path $Root '.venv\Scripts\python.exe'); Pre = @() }
  if ($env:CONDA_PREFIX) { $candidates += [pscustomobject]@{ Exe = (Join-Path $env:CONDA_PREFIX 'python.exe'); Pre = @() } }
  $bases = @('D:\anaconda3', 'C:\ProgramData\anaconda3', 'C:\anaconda3')
  if ($env:USERPROFILE) {
    $bases += (Join-Path $env:USERPROFILE 'anaconda3')
    $bases += (Join-Path $env:USERPROFILE 'miniconda3')
  }
  foreach ($b in $bases) {
    foreach ($e in @('torch_cu128', 'torch', 'qwen', 'base')) {
      $candidates += [pscustomobject]@{ Exe = (Join-Path $b ('envs\' + $e + '\python.exe')); Pre = @() }
    }
    $candidates += [pscustomobject]@{ Exe = (Join-Path $b 'python.exe'); Pre = @() }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { $candidates += [pscustomobject]@{ Exe = $py.Source; Pre = @('-3.11') } }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) { $candidates += [pscustomobject]@{ Exe = $python.Source; Pre = @() } }

  $tried = @{}
  foreach ($c in $candidates) {
    $key = ($c.Exe + ' ' + ($c.Pre -join ' ')).ToLower()
    if ($tried.ContainsKey($key)) { continue }
    $tried[$key] = $true
    # 微软商店的 python.exe 是占位程序，运行会弹商店，直接跳过。
    if ($c.Exe -like '*WindowsApps*') { continue }
    if (-not (Test-Path $c.Exe)) { continue }
    Write-Note ('尝试 Python：' + $c.Exe)
    $info = Get-PythonInfo -Exe $c.Exe -PreArgs $c.Pre
    if ($info) { return $info }
  }
  return $null
}

function Test-ModelDir {
  param([string]$Dir)
  if (-not $Dir) { return $false }
  if (-not (Test-Path $Dir)) { return $false }
  return (Test-Path (Join-Path $Dir 'config.json'))
}

function Find-ModelDir {
  $list = @()
  if ($env:OPENBRIDGE_MODEL_DIR) { $list += $env:OPENBRIDGE_MODEL_DIR }
  $list += (Join-Path $Root 'model\Qwen3-VL-2B-Instruct')
  $list += (Join-Path $Root 'Qwen3-VL-2B-Instruct')
  $list += (Join-Path (Split-Path -Parent $Root) 'qwen\Qwen\Qwen3-VL-2B-Instruct')
  $list += 'D:\qwen\Qwen\Qwen3-VL-2B-Instruct'
  $list += 'C:\qwen\Qwen\Qwen3-VL-2B-Instruct'
  if ($env:USERPROFILE) { $list += (Join-Path $env:USERPROFILE 'qwen\Qwen\Qwen3-VL-2B-Instruct') }
  foreach ($d in $list) {
    if (Test-ModelDir $d) { return (Resolve-Path $d).Path }
  }
  # Hugging Face 缓存（hf / modelscope 下载后的常见位置），取最新的 snapshot 子目录。
  if ($env:USERPROFILE) {
    $snap = Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--Qwen--Qwen3-VL-2B-Instruct\snapshots'
    if (Test-Path $snap) {
      foreach ($s in (Get-ChildItem $snap -Directory | Sort-Object LastWriteTime -Descending)) {
        if (Test-ModelDir $s.FullName) { return $s.FullName }
      }
    }
  }
  return $null
}

# ---------------------------------------------------------------- 端口兜底
# 8080 是 Qwen 的默认端口，但用户机器上它经常已被别的程序占用。若 8080 上
# 没有模型服务（/v1/models 不通），自动往后找一个空闲端口，并把新地址传给
# Node，避免启动后等 5 分钟才降级。用户显式设置 MODEL_PORT / MODEL_URL 时
# 不覆盖用户的选择。
if (-not $env:MODEL_PORT -and -not $env:OPENBRIDGE_MODEL_URL) {
  $modelResponds = Test-Http -Url $modelUrl -TimeoutSec 2
  if (-not $modelResponds -and (Test-Port $modelPort)) {
    $existing = $null
    $free = $null
    foreach ($candidate in 8081..8090) {
      $candidateUrl = 'http://127.0.0.1:' + $candidate + '/v1/models'
      if (Test-Http -Url $candidateUrl -TimeoutSec 1) { $existing = $candidate; break }
      if (-not $free -and -not (Test-Port $candidate)) { $free = $candidate }
    }
    if ($existing) {
      $modelPort = $existing
      $modelUrl = 'http://127.0.0.1:' + $modelPort + '/v1/models'
      $env:MODEL_PORT = [string]$modelPort
      $env:OPENBRIDGE_MODEL_URL = 'http://127.0.0.1:' + $modelPort
      Write-Warn ('8080 已被其它程序占用；检测到 ' + $modelPort + ' 已有模型服务，直接复用。')
    } elseif ($free) {
      $modelPort = $free
      $modelUrl = 'http://127.0.0.1:' + $modelPort + '/v1/models'
      $env:MODEL_PORT = [string]$modelPort
      $env:OPENBRIDGE_MODEL_URL = 'http://127.0.0.1:' + $modelPort
      Write-Warn ('8080 已被其它程序占用，模型自动改用空闲端口 ' + $modelPort + '。')
    }
  }
}

# ---------------------------------------------------------------- 横幅
Write-Host ''
Write-Host '  OpenBridge 开源桥 · 一键启动' -ForegroundColor White
Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
Write-Note ('项目目录：' + $Root)
Write-Note ('网页端口：' + $webPort + '    模型端口：' + $modelPort)

$node = Find-Node
if (-not $node) {
  Write-Err '没有找到 Node.js（本项目需要 18 或更高版本）。'
  Write-Note '安装：打开 https://nodejs.org/ 下载 LTS 版，一路“下一步”，装完重新双击 启动.bat。'
  Write-Note '装好后可在命令行输入 node -v 确认能看到版本号。'
  exit 1
}
$nodeVersion = (& $node -v 2>$null)
Write-Ok ('Node.js ' + $nodeVersion + '  ->  ' + $node)

$webRunning   = Test-Http -Url $statusUrl
$modelRunning = Test-Http -Url $modelUrl

# ---------------------------------------------------------------- 环境自检
if ($Diagnose) {
  Write-Title '环境自检'
  Write-Ok ('Node.js：' + $nodeVersion)
  Write-Note ('路径 ' + $node)

  Write-Host ''
  Write-Note '检查 Python（需要 torch + transformers，首次导入可能要十几秒）…'
  $py = Find-Python
  if ($py) {
    Write-Ok ('Python ' + $py.Python + '，torch ' + $py.Torch + '，transformers ' + $py.Transformers)
    Write-Note ('路径 ' + $py.Exe)
  } else {
    Write-Warn '没有找到同时装有 torch 和 transformers 的 Python。'
    Write-Note '只看看界面不受影响；要做真实模型演示，请按 docs\运行说明.md 第 3 节创建环境，'
    Write-Note '或用 $env:OPENBRIDGE_PYTHON 指向已有的 python.exe。'
  }

  Write-Host ''
  $md = Find-ModelDir
  if ($md) {
    Write-Ok ('模型权重：' + $md)
  } else {
    Write-Warn '没有找到 Qwen3-VL-2B-Instruct 权重目录（需含 config.json）。'
    Write-Note '权重不随项目分发；下载后用 $env:OPENBRIDGE_MODEL_DIR 指定，或放到 model\Qwen3-VL-2B-Instruct。'
  }

  Write-Host ''
  if ($webRunning)   { Write-Ok  ('网页服务已在运行：' + $webUrl) } else { Write-Warn ('网页端口 ' + $webPort + ' 空闲（运行 启动.bat 会启动它）') }
  if ($modelRunning) { Write-Ok  ('模型服务已在运行：' + $modelUrl) } elseif (Test-Port $modelPort) { Write-Warn ('模型端口 ' + $modelPort + ' 被其它程序占用') } else { Write-Note ('模型端口 ' + $modelPort + ' 空闲') }

  Write-Host ''
  $need = @('server.mjs', 'data\sample-project.json', 'data\test-cases.json', 'resources\requests\SOURCE.md')
  $missing = @()
  foreach ($f in $need) { if (-not (Test-Path (Join-Path $Root $f))) { $missing += $f } }
  if ($missing.Count -eq 0) { Write-Ok '项目数据文件齐全（server.mjs / data / resources）' }
  else { Write-Err ('缺少文件：' + ($missing -join ', ')); Write-Note '压缩包可能没有解压完整，请重新解压。' }

  Write-Host ''
  Write-Host '  自检结束。完整启动：双击 启动.bat；只开网页：双击 启动-仅网页.bat。' -ForegroundColor DarkGray
  exit 0
}

# ---------------------------------------------------------------- 启动网页工作台
Write-Title '网页工作台'
if ($webRunning) {
  Write-Ok ('已有实例在运行，直接复用：' + $webUrl)
} elseif (Test-Port $webPort) {
  Write-Err ('端口 ' + $webPort + ' 已被其它程序占用，网页服务无法启动。')
  Write-Note '先关掉占用该端口的程序，或临时换端口：$env:PORT=5000 后再运行 启动.bat。'
  exit 1
} else {
  Start-Process -FilePath $node -ArgumentList @('server.mjs') -WorkingDirectory $Root | Out-Null
  if (Wait-Service -Url $statusUrl -TimeoutSec 40 -Label '网页服务') {
    Write-Ok ('网页服务已启动：' + $webUrl)
  } else {
    Write-Err '网页服务启动超时。请看弹出的 Node 窗口里的报错。'
    exit 1
  }
}

# ---------------------------------------------------------------- 启动模型服务
$degraded = $false
if ($WebOnly) {
  Write-Title '模型服务'
  Write-Warn '按参数要求跳过模型，当前为“仅网页”模式（界面显示“规则降级”）。'
  $degraded = $true
} elseif ($modelRunning) {
  Write-Title '模型服务'
  Write-Ok ('检测到模型服务已在运行，直接复用：' + $modelUrl)
} else {
  Write-Title '模型服务'
  $modelDir = Find-ModelDir
  if (-not $modelDir) {
    Write-Warn '没有找到 Qwen3-VL-2B-Instruct 权重目录，降级为“仅网页”模式。'
    Write-Note '权重不随项目分发。下载后用 $env:OPENBRIDGE_MODEL_DIR 指定，'
    Write-Note '或把权重放到 <项目>\model\Qwen3-VL-2B-Instruct 后重新运行。'
    $degraded = $true
  } else {
    Write-Note ('权重：' + $modelDir)
    $py = Find-Python
    if (-not $py) {
      Write-Warn '没有找到带 torch + transformers 的 Python，降级为“仅网页”模式。'
      Write-Note '按 docs\运行说明.md 第 3 节创建环境，或用 $env:OPENBRIDGE_PYTHON 指定 python.exe。'
      $degraded = $true
    } else {
      Write-Note ('Python：' + $py.Exe + '  (torch ' + $py.Torch + ')')
      $env:OPENBRIDGE_MODEL_DIR = $modelDir
      $argList = @()
      $argList += $py.Pre
      $argList += (Join-Path $Root 'model\serve.py')
      # 路径可能有空格，逐个加引号交给 Start-Process。
      $quoted = @()
      foreach ($a in $argList) {
        if ($a -match '\s') { $quoted += ('"' + $a + '"') } else { $quoted += $a }
      }
      Start-Process -FilePath $py.Exe -ArgumentList $quoted -WorkingDirectory $Root | Out-Null
      Write-Note '已在新窗口加载模型（首次启动含预热，通常 30 秒到 3 分钟）。'
      Write-Host '  等待模型就绪' -NoNewline -ForegroundColor DarkGray
      if (Wait-Service -Url $modelUrl -TimeoutSec 300 -Label '模型服务') {
        Write-Ok ('模型服务已就绪：' + $modelUrl)
      } else {
        Write-Warn '5 分钟内没等到模型服务。请看模型窗口的报错（显存不足、权重损坏等）。'
        Write-Note '网页仍可使用，但会显示“规则降级”。'
        $degraded = $true
      }
    }
  }
}

# ---------------------------------------------------------------- 打开浏览器
if (-not $NoBrowser) {
  Start-Process $webUrl | Out-Null
  Write-Ok ('已打开浏览器：' + $webUrl)
}

# ---------------------------------------------------------------- 汇总
Write-Host ''
Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
if ($degraded) {
  Write-Host '  已启动：网页工作台（规则降级，模型未接通）' -ForegroundColor Yellow
  Write-Note '界面、证据浏览器、离线评测仍可正常演示；真实模型问答需要模型服务在线。'
} else {
  Write-Host '  已启动：网页工作台 + 本地 Qwen 模型' -ForegroundColor Green
  Write-Note '网页右上角出现“本地 Qwen 模型在线”即可开始提问。'
}
Write-Host ''
Write-Note ('网页：' + $webUrl)
Write-Note ('模型：' + $modelUrl)
Write-Note '停止：关闭弹出的 Node / Python 窗口，或在各自窗口按 Ctrl+C。'
Write-Note '换目录、换电脑、U 盘：直接复制整个文件夹，双击 启动.bat 即可，无需改路径。'
Write-Host ''
exit 0