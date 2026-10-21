$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$testRoot = Join-Path $projectRoot 'test-distribution'

if (-not (Test-Path $envPath)) {
    throw ".env not found at $envPath. Keep the JAVA_EXECUTABLE line from your existing Nebula .env, then run this script again."
}

$lines = [System.Collections.Generic.List[string]](Get-Content $envPath)

function Set-EnvLine([string]$name, [string]$value) {
    $prefix = "$name="
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].StartsWith($prefix)) {
            $lines[$i] = "$prefix$value"
            return
        }
    }
    $lines.Add("$prefix$value")
}

Set-EnvLine 'ROOT' $testRoot
Set-EnvLine 'BASE_URL' 'http://127.0.0.1:8080/'

[System.IO.File]::WriteAllLines(
    $envPath,
    $lines,
    (New-Object System.Text.UTF8Encoding($false))
)

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

Write-Host ''
Write-Host 'NeoForge TEST environment isolated successfully.' -ForegroundColor Green
Write-Host "ROOT     = $testRoot"
Write-Host 'BASE_URL = http://127.0.0.1:8080/'
Write-Host 'JAVA_EXECUTABLE was left unchanged.'
