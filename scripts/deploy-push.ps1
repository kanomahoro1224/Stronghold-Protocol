# 卫戍协议：盟约 · 本分支的部署驱动（在开发机上运行，Windows PowerShell 5.1 兼容）
#
#   # 先看会改什么（默认就是预演，不写远程任何文件）
#   powershell -File scripts\deploy-push.ps1 -Target wei
#
#   # 正式更新一台（--apply 语义；脚本会在目标机做备份、完整性校验、重启、健康门，失败自动回滚）
#   powershell -File scripts\deploy-push.ps1 -Target wei -Apply
#
#   # 三台依次更新（每台各自跑完整流程，前一台失败就停下）
#   powershell -File scripts\deploy-push.ps1 -Target all -Apply
#
#   # 忙机（160）重启前预热哈希缓存，避免首次启动在 900 MB 素材上算 SHA-256 把 vCPU 占满
#   powershell -File scripts\deploy-push.ps1 -Target 160 -Apply -Prewarm
#
# 目标机清单默认读 .cache\deploy\targets.json（不入库，含主机地址与密钥路径）：
#   { "wei": { "host": "1.2.3.4", "key": "%USERPROFILE%\.ssh\id_ed25519_xxx", "note": "wei.xiaolubao.com" } }
#
# 两点环境事实（2026-10-14 实测）：
#   * 这几台机器没有 scp/sftp 子系统，传输走 `ssh ... "base64 -d > file"`，载荷与脚本都这么送。
#   * 目标机不执行 git pull（/opt/stronghold 不是 git 检出），部署 = 文件同步 + 重启。
param(
  [string]$Target = '',
  [string]$HostName = '',
  [string]$Key = '',
  [string]$TargetsFile = '',
  [string]$Payload = '',
  [switch]$Apply,
  [switch]$Prewarm,
  [switch]$Build,
  [switch]$NoBuildCheck
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $TargetsFile) { $TargetsFile = Join-Path $repo '.cache\deploy\targets.json' }
if (-not $Payload) { $Payload = Join-Path $repo '.cache\deploy\stronghold-code.tar.gz' }

function Invoke-Ssh([string]$h, [string]$k, [string]$command) {
  $sshArgs = @('-i', $k, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=25', "root@$h", $command)
  & ssh @sshArgs 2>&1
}

function Send-Base64([string]$h, [string]$k, [string]$localFile, [string]$remotePath) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($localFile))
  $out = $b64 | & ssh -i $k -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 "root@$h" "base64 -d > $remotePath 2>/dev/null; sha256sum $remotePath | cut -d' ' -f1"
  return ($out | Select-Object -Last 1)
}

# ------------------------------------------------------------------ 目标解析
$targets = @()
if ($HostName -and $Key) {
  $targets = @([pscustomobject]@{ name = ($HostName); host = $HostName; key = [Environment]::ExpandEnvironmentVariables($Key) })
} else {
  if (-not (Test-Path $TargetsFile)) { throw "找不到目标机清单 $TargetsFile；用 -HostName/-Key 直接指定，或先创建该文件。" }
  $cfg = Get-Content $TargetsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $names = @($cfg.PSObject.Properties.Name)
  if (-not $Target) { throw "请用 -Target <名字>，可用：$($names -join ', ')" }
  if ($Target -eq 'all') { $names = $names } elseif ($names -contains $Target) { $names = @($Target) } else { throw "未知目标 '$Target'，可用：$($names -join ', ')" }
  foreach ($n in $names) {
    $e = $cfg.$n
    $targets += [pscustomobject]@{ name = $n; host = $e.host; key = [Environment]::ExpandEnvironmentVariables($e.key) }
  }
}

# ------------------------------------------------------------------ 载荷
if ($Build -or -not (Test-Path $Payload)) {
  Write-Host '== npm run build =='
  & npm run build 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
  Write-Host '== 打包载荷（server/ shared/ public/ 除 public/assets + 两个 package 文件）'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Payload) | Out-Null
  if (Test-Path $Payload) { Remove-Item $Payload -Force }
  & tar -czf $Payload --exclude 'public/assets' server shared public package.json package-lock.json
  if ($LASTEXITCODE -ne 0) { throw '打包失败' }
}

if (-not (Test-Path $Payload)) { throw "载荷不存在：$Payload（先加 -Build，或指定 -Payload）" }
# 载荷自检：必须有构建产物，且不能把 900 MB 的 public/assets 素材树打进来。
$listing = & tar -tzf $Payload
$hasBuild = @($listing | Where-Object { $_ -like 'public/build/assets/*' }).Count
$hasAssets = @($listing | Where-Object { $_ -like 'public/assets/*' }).Count
if ($hasBuild -eq 0) { throw '载荷里没有 public/build/assets/*，页面会 404（先 npm run build）' }
if ($hasAssets -gt 0) { throw "载荷误含 public/assets/*（$hasAssets 项），会白传 900 MB 素材" }
Write-Host "== 载荷自检通过：public/build/assets $hasBuild 项，public/assets 0 项"
$sha = (Get-FileHash $Payload -Algorithm SHA256).Hash.ToLower()
$payloadVersion = (Select-String -Path (Join-Path $repo 'package.json') -Pattern '"version"' | Select-Object -First 1).Line.Trim()
Write-Host "== 载荷 $Payload"
Write-Host "   sha256=$sha"
Write-Host "   $payloadVersion"

$remoteScript = Join-Path $repo 'scripts\deploy-remote.sh'
if (-not (Test-Path $remoteScript)) { throw "找不到 $remoteScript" }

# ------------------------------------------------------------------ 逐台
foreach ($t in $targets) {
  Write-Host ''
  Write-Host "==================== $($t.name)  ($($t.host)) ===================="
  $remoteTar = '/root/stronghold-code.tar.gz'
  $remoteSh = '/root/deploy-remote.sh'

  Write-Host '-- 上传脚本'
  $s1 = Send-Base64 $t.host $t.key $remoteScript $remoteSh
  Write-Host "-- 上传载荷 ($([math]::Round((Get-Item $Payload).Length / 1MB, 1)) MB)"
  $s2 = Send-Base64 $t.host $t.key $Payload $remoteTar
  if ($s2 -ne $sha) { throw "载荷校验失败：远端 $s2 ≠ 本地 $sha" }
  Write-Host "   远端 sha256 一致"

  $mode = '预演'
  $args = ''
  if ($Apply) { $mode = '正式'; $args = ' --apply' }
  if ($Prewarm -and $Apply) { $args = "$args --prewarm" }
  Write-Host "-- 执行（$mode）"
  $cmd = "bash $remoteSh $remoteTar$args"
  Invoke-Ssh $t.host $t.key $cmd | ForEach-Object { "   $_" }
  if ($LASTEXITCODE -ne 0 -and $Apply) {
    Write-Host "!! $($t.name) 返回非零（$LASTEXITCODE）；已按脚本内的健康门处理，请查看上面的输出"
    exit $LASTEXITCODE
  }
}
Write-Host ''
Write-Host '== 完成'
