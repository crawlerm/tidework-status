# tidework PC GPU heartbeat.
# Writes heartbeat.json to a secret GitHub gist every run; the status collector reads it.
# Run every 15 min from Task Scheduler (see pc/README.md). Needs two user environment
# variables: TIDEWORK_GIST_ID and TIDEWORK_GIST_TOKEN (a token with Gists: read and write only).

$ErrorActionPreference = "Stop"
$GistId = $env:TIDEWORK_GIST_ID
$Token  = $env:TIDEWORK_GIST_TOKEN
if (-not $GistId -or -not $Token) { Write-Error "Set TIDEWORK_GIST_ID and TIDEWORK_GIST_TOKEN"; exit 1 }

$hb = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString("o"); host = $env:COMPUTERNAME; cuda = $false }
try {
  $out = & nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1
  if ($LASTEXITCODE -eq 0) {
    $f = ($out | Select-Object -First 1).ToString().Split(",") | ForEach-Object { $_.Trim() }
    $hb.cuda         = $true
    $hb.gpu_name     = $f[0]
    $hb.util_pct     = [int]$f[1]
    $hb.mem_used_mb  = [int]$f[2]
    $hb.mem_total_mb = [int]$f[3]
    $hb.temp_c       = [int]$f[4]
  } else {
    $hb.error = "nvidia-smi exit code $LASTEXITCODE"
  }
} catch {
  $hb.error = "nvidia-smi not found"
}

$body = @{ files = @{ "heartbeat.json" = @{ content = ($hb | ConvertTo-Json -Compress) } } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Patch -Uri "https://api.github.com/gists/$GistId" `
  -Headers @{ Authorization = "Bearer $Token"; Accept = "application/vnd.github+json" } `
  -Body $body -ContentType "application/json" | Out-Null
