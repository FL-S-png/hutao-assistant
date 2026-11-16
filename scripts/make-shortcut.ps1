<#
  胡桃助手 · 创建桌面快捷方式（便携版用）
  ------------------------------------------------------------
  为什么需要这个脚本：
    本程序是解压即用的绿色版，没有任何安装程序，解压后不会自动生成桌面图标；
    而部分机器（虚拟显示适配器异常 / Microsoft 基本显示适配器 报错）双击裸 exe
    会在 Electron 初始化阶段直接 int3 崩溃（事件日志 0x80000003），必须在命令行
    带 --in-process-gpu --disable-gpu-compositing --no-sandbox 才能启动。
    快捷方式就是把「exe 路径 + 这三个参数」固化下来。

  用法：
    双击同目录的「创建桌面快捷方式.cmd」即可（幂等，重复跑只会更新）。
    命令行参数：
      -NoArgs     不追加三参数（显卡正常的机器可以这样，性能更好）
      -Launch     建完立刻用这个快捷方式启动
      -Startup    顺便丢一份到「启动」文件夹（开机自启）
      -AllUsers   建到公共桌面（所有用户可见，需要管理员）
      -Remove     删掉桌面 / 启动文件夹里的快捷方式
      -Quiet      不打印过程
#>
[CmdletBinding()]
param(
    [switch]$NoArgs,
    [switch]$Launch,
    [switch]$Startup,
    [switch]$AllUsers,
    [switch]$Remove,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }

# ---------- 1. 定位 exe ----------
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Say "脚本所在目录：$root"

$skip = '^(unins|uninstall|elevate|crashpad|squirrel|update)'
$candidates = @()
foreach ($dir in @($root, (Split-Path -Parent $root), (Join-Path (Split-Path -Parent $root) '胡桃助手'))) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    $candidates += Get-ChildItem -LiteralPath $dir -Filter *.exe -File -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -notmatch $skip -and $_.Length -gt 1MB }
}
$exe = $candidates | Sort-Object Length -Descending | Select-Object -First 1

# 兜底：脚本被挪到别处（例如桌面）时，往下找两级，认名字里带「胡桃」的那一个
if (-not $exe) {
    $exe = Get-ChildItem -LiteralPath $root -Filter *.exe -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -notmatch $skip -and $_.Length -gt 1MB -and $_.Name -match '胡桃|genshin|route' } |
           Sort-Object Length -Descending | Select-Object -First 1
}
if (-not $exe) {
    Say '× 没找到可执行文件。请把这个脚本放回「胡桃助手」便携版目录（和 exe 同一层）再运行。'
    exit 1
}
$exePath = $exe.FullName
$appName = [System.IO.Path]::GetFileNameWithoutExtension($exe.Name)
Say "目标程序：$exePath"

# ---------- 2. 判断要不要加三参数 ----------
# 有异常显示适配器（Status 非 OK / 设备有问题代码 / Microsoft 基本显示适配器）
# 就说明这台机器大概率会在 Electron 初始化时 int3 崩溃。
function Get-DisplayReport {
    $rows = @()
    try {
        $rows = Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop |
                ForEach-Object {
                    [pscustomobject]@{
                        Name   = $_.Name
                        Status = "$($_.Status)"
                        Code   = [int]$_.ConfigManagerErrorCode
                        Bad    = ("$($_.Status)" -ne 'OK') -or ([int]$_.ConfigManagerErrorCode -ne 0) -or
                                 ($_.Name -match '基本显示|Basic Display')
                    }
                }
    } catch { }
    return $rows
}

$gpus  = Get-DisplayReport
$badGpu = @($gpus | Where-Object { $_.Bad })

if ($gpus.Count -gt 0) {
    Say '显示适配器：'
    foreach ($g in $gpus) {
        $flag = if ($g.Bad) { '  <- 异常' } else { '' }
        Say ("  · {0}  Status={1} Code={2}{3}" -f $g.Name, $g.Status, $g.Code, $flag)
    }
}

$needsFlags = $false
$reason = ''
if ($NoArgs) {
    $needsFlags = $false
    $reason = '按 -NoArgs 要求，不追加参数'
} elseif (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
    $needsFlags = $true
    $reason = '查不到显卡信息，按「保守起见带参数」处理'
} elseif ($badGpu.Count -gt 0) {
    $needsFlags = $true
    $reason = '检测到异常显示适配器，带参数启动才稳'
} else {
    $needsFlags = $false
    $reason = '显示适配器都正常，裸启动即可（性能更好）'
}

$extraArgs = ''
if ($needsFlags) { $extraArgs = '--in-process-gpu --disable-gpu-compositing --no-sandbox' }
$argText = '（无）'
if ($extraArgs) { $argText = $extraArgs }
Say "启动参数：$argText  —— $reason"

# ---------- 3. 建/更新快捷方式 ----------
$desktop = if ($AllUsers) {
    [Environment]::GetFolderPath('CommonDesktopDirectory')
} else {
    [Environment]::GetFolderPath('Desktop')
}
$lnkPath = Join-Path $desktop ($appName + '.lnk')

$shell = New-Object -ComObject WScript.Shell

function Write-Lnk([string]$path, [string]$target, [string]$argument, [string]$workDir, [string]$icon, [string]$desc) {
    $sc = $shell.CreateShortcut($path)
    $sc.TargetPath       = $target
    $sc.Arguments        = $argument
    $sc.WorkingDirectory = $workDir
    $sc.IconLocation     = $icon
    $sc.Description      = $desc
    $sc.WindowStyle      = 1
    $sc.Save()
}

if ($Remove) {
    $removed = @()
    foreach ($p in @($lnkPath, (Join-Path ([Environment]::GetFolderPath('Programs')) ($appName + '.lnk')), (Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\Startup\' + $appName + '.lnk')))) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $removed += $p }
    }
    if ($removed.Count) { Say "已删除："; $removed | ForEach-Object { Say "  · $_" } }
    else { Say '桌面上没有这个快捷方式，无需删除。' }
    exit 0
}

$existed = Test-Path -LiteralPath $lnkPath
$modeTag = ''
if ($extraArgs) { $modeTag = ' · 兼容模式' }
$desc = $appName + '（便携版' + $modeTag + '）'
Write-Lnk -path $lnkPath -target $exePath -argument $extraArgs -workDir $root `
          -icon ($exePath + ',0') -desc $desc

# 读回验证，避免「以为建好了其实参数没写进去」
$check = $shell.CreateShortcut($lnkPath)
Say ''
Say "桌面快捷方式：$lnkPath"
Say "  目标：$($check.TargetPath)"
$checkArgs = '（无）'
if ($check.Arguments) { $checkArgs = $check.Arguments }
Say "  参数：$checkArgs"
Say "  起始位置：$($check.WorkingDirectory)"

$ok = ($check.TargetPath -eq $exePath) -and ($check.Arguments -eq $extraArgs)
if (-not $ok) { Say '× 写回校验不通过，请手动检查。'; exit 2 }
Say $(if ($existed) { '√ 已更新（原来就有，参数按当前机器重写）' } else { '√ 已创建' })

if ($Startup) {
    $startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    $startupLnk = Join-Path $startupDir ($appName + '.lnk')
    Write-Lnk -path $startupLnk -target $exePath -argument $extraArgs -workDir $root `
              -icon ($exePath + ',0') -desc ($appName + '（开机自启）')
    Say "√ 开机自启已加入：$startupLnk"
}

if ($Launch) {
    # 有些包装环境（bash / CI）会留下 ELECTRON_RUN_AS_NODE=1，
    # 那会让 Electron 当纯 Node 跑、一闪就退，所以启动前先清掉。
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Say '正在启动…'
    Start-Process -FilePath $lnkPath
}

Say ''
Say '完成。以后双击桌面图标即可（不要双击 exe 本身）。'
exit 0
