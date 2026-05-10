# AI Factory: build (npm run dist) + install in one shot
Set-Location "C:\Users\scott\Code\aifactory"

Write-Host "==> Closing running AI Factory processes..." -ForegroundColor Cyan

$killed = 0

Get-Process -Name "AI Factory" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "    killing AI Factory.exe pid=$($_.Id)" -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $script:killed++
}

Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $p = $_.Path
        if ($p -and $p -like "*\Programs\AI Factory\*") {
            Write-Host "    killing AI Factory node.exe pid=$($_.Id)" -ForegroundColor DarkGray
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            $script:killed++
        }
    } catch {}
}

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "AI Factory Setup*" } | ForEach-Object {
    Write-Host "    killing $($_.ProcessName) pid=$($_.Id)" -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $script:killed++
}

if ($killed -gt 0) {
    Start-Sleep -Milliseconds 500
    Write-Host "    closed $killed process(es)" -ForegroundColor DarkGray
} else {
    Write-Host "    none running" -ForegroundColor DarkGray
}

Write-Host "==> Bumping patch version..." -ForegroundColor Cyan
$newVersion = node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));const [a,b,c]=p.version.split('.');p.version=a+'.'+b+'.'+(+c+1);fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n','utf8');process.stdout.write(p.version);"
Write-Host "    version -> $newVersion" -ForegroundColor DarkGray

Write-Host "==> Building AI Factory (npm run dist)..." -ForegroundColor Cyan
npm run dist
if (-not $?) {
    Write-Host "==> Build failed. Aborting." -ForegroundColor Red
    exit 1
}

$installer = Get-ChildItem "dist\AI Factory Setup *.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    Write-Host "==> No installer found in dist\. Aborting." -ForegroundColor Red
    exit 1
}

$privateName = $installer.FullName -replace 'AI Factory Setup', 'AI Factory Private Setup'
Rename-Item $installer.FullName $privateName -Force
Write-Host "    renamed -> $(Split-Path $privateName -Leaf)" -ForegroundColor DarkGray

Write-Host "==> Running installer: $(Split-Path $privateName -Leaf)" -ForegroundColor Cyan
Start-Process $privateName -Wait

Write-Host "==> Done." -ForegroundColor Green
