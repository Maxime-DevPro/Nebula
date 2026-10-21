$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$runtimeRoot = Join-Path $env:APPDATA '.Bedragoth-NeoForge-Test\runtime\x64'

if (-not (Test-Path $runtimeRoot)) {
    throw "NeoForge TEST Java runtime folder not found: $runtimeRoot`nOpen Bedragoth NeoForge TEST and use 'Installer Java' first."
}

$candidates = Get-ChildItem -Path $runtimeRoot -Filter java.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]bin[\\/]java\.exe$' }

$java21 = $null
foreach ($candidate in $candidates) {
    # Java writes `-version` to stderr. PowerShell 5.1 may surface native stderr
    # as an error record when $ErrorActionPreference is Stop, so capture both
    # streams through temporary files instead of piping stderr directly.
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $candidate.FullName `
            -ArgumentList '-version' `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutFile `
            -RedirectStandardError $stderrFile

        $versionOutput = ((Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue))
        if ($process.ExitCode -eq 0 -and $versionOutput -match 'version\s+"21(?:\.|\")') {
            $java21 = $candidate.FullName
            break
        }
    }
    finally {
        Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not $java21) {
    throw "No Java 21 java.exe was found under $runtimeRoot`nOpen Bedragoth NeoForge TEST and reinstall Java 21 if needed."
}

if (-not (Test-Path $envFile)) {
    New-Item -ItemType File -Path $envFile -Force | Out-Null
}

$lines = @(Get-Content $envFile -ErrorAction SilentlyContinue)
$found = $false
$newLines = foreach ($line in $lines) {
    if ($line -match '^JAVA_EXECUTABLE=') {
        $found = $true
        "JAVA_EXECUTABLE=$java21"
    } else {
        $line
    }
}
if (-not $found) {
    $newLines += "JAVA_EXECUTABLE=$java21"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envFile, [string[]]$newLines, $utf8NoBom)

Write-Host ''
Write-Host 'Nebula-NeoForge now uses Java 21:'
Write-Host $java21
Write-Host ''
& $java21 -version
