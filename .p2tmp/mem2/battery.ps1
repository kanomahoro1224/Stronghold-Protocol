param([string]$Out = '.p2tmp/mem2/out.log', [string]$Probe = '.p2tmp/mem2/slope2.mjs', [int]$N1 = 12, [int]$N2 = 12, [string[]]$Variants = @('A1','B1','A7','B7','A13','B13','P7','P13','Q1','Q7','Q13','S1','S7','S13','U1','U7'))
$variants = $Variants
$logPath = $Out
"# battery $logPath  N1=$N1 N2=$N2  $(Get-Date -Format o)" | Out-File -Encoding utf8 $logPath
foreach ($v in $variants) {
  $t0 = Get-Date
  $res = node --expose-gc $Probe $v $N1 $N2 2>&1
  $res | Out-File -Encoding utf8 -Append $logPath
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  "  [$v took ${secs}s]" | Out-File -Encoding utf8 -Append $logPath
}
"# done $(Get-Date -Format o)" | Out-File -Encoding utf8 -Append $logPath
