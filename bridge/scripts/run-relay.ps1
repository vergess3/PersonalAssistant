# Resident launcher for the Hilly Weixin <-> Slack relay (scheduled task target).
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (Test-Path -LiteralPath (Join-Path $root 'state\relay.stop')) { exit 0 }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$retrySeconds = 5
while (-not (Test-Path -LiteralPath (Join-Path $root 'state\relay.stop'))) {
    $startedAt = Get-Date
    & $node src/connector-main.mjs --forward >> relay-output.log 2>> relay-error.log
    $relayExitCode = $LASTEXITCODE
    if ($relayExitCode -eq 0 -or (Test-Path -LiteralPath (Join-Path $root 'state\relay.stop'))) { exit $relayExitCode }
    if (((Get-Date) - $startedAt).TotalMinutes -ge 5) { $retrySeconds = 5 }
    @{ at=(Get-Date).ToUniversalTime().ToString('o'); status='worker_restart'; exitCode=$relayExitCode; delaySeconds=$retrySeconds } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath 'relay-supervisor.log' -Encoding UTF8
    for ($i=0; $i -lt $retrySeconds; $i++) {
        if (Test-Path -LiteralPath (Join-Path $root 'state\relay.stop')) { exit 0 }
        Start-Sleep -Seconds 1
    }
    $retrySeconds = [Math]::Min(60, $retrySeconds * 2)
}
