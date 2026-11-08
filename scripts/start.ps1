$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appUrl = 'http://127.0.0.1:4173'
Set-Location -LiteralPath $projectRoot

function Test-Raspisulik {
    try {
        $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2
        return $health.app -eq 'raspisulik'
    } catch { return $false }
}

try {
    if (Test-Raspisulik) { Start-Process $appUrl; exit 0 }
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = & $nodePath -p 'process.versions.node'
    if ([version]$nodeVersion -lt [version]'22.18.0') { throw 'Для запуска нужен Node.js версии 22.18 или новее.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
        throw 'Сначала выполните npm install, затем npm run build в папке проекта.'
    }
    $logDir = Join-Path $projectRoot '.local'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $serverFile = Join-Path $projectRoot 'server\index.mjs'
    $process = Start-Process -FilePath $nodePath -ArgumentList @('--experimental-strip-types', ('"' + $serverFile + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        if (Test-Raspisulik) {
            $process.Id | Set-Content -LiteralPath (Join-Path $logDir 'server.pid')
            Start-Process $appUrl
            Write-Host "Raspisulik: $appUrl"
            exit 0
        }
        if ($process.HasExited) { throw 'Приложение не запустилось. Подробности в .local\server-error.log. Возможно, порт 4173 занят.' }
        Start-Sleep -Milliseconds 200
    }
    throw 'Приложение не ответило. Подробности в .local\server-error.log.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Нажмите Enter, чтобы закрыть окно'
    exit 1
}
