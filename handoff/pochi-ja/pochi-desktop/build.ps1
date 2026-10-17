param([switch]$Test, [string]$OutputDirectory = 'dist-ja')
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compilerPath = Join-Path $frameworkRoot 'csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'Windows の .NET Framework 4.x が必要です（4.8 推奨）。' }
$releasePath = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $projectRoot $OutputDirectory }
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
$arguments = @('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/langversion:5', '/utf8output')
$arguments += '/out:"' + (Join-Path $releasePath 'Pochi.exe') + '"'
$arguments += '/win32icon:"' + (Join-Path $projectRoot 'assets/pet.ico') + '"'
foreach ($assembly in @('System.dll','System.Core.dll','System.Xaml.dll','System.Web.Extensions.dll','System.Drawing.dll','System.Windows.Forms.dll')) {
    $arguments += '/reference:"' + (Join-Path $frameworkRoot $assembly) + '"'
}
$speechPath = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET/assembly/GAC_MSIL/System.Speech') -Filter 'System.Speech.dll' -Recurse -File | Select-Object -First 1 -ExpandProperty FullName
if (-not $speechPath) { throw 'Windows の System.Speech が見つかりません。' }
$arguments += '/reference:"' + $speechPath + '"'
foreach ($assembly in @('WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll')) {
    $arguments += '/reference:"' + (Join-Path (Join-Path $frameworkRoot 'WPF') $assembly) + '"'
}
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'assets') -Recurse -File | Where-Object { $_.Extension -in '.png','.json','.wav','.ico' } | Sort-Object FullName | ForEach-Object {
    $assetRelative = $_.FullName.Substring((Join-Path $projectRoot 'assets').Length + 1).Replace('\','.')
    $arguments += '/resource:"' + $_.FullName + '",Pochi.assets.' + $assetRelative
}
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $arguments += '"' + $_.FullName + '"' }
$responsePath = Join-Path $projectRoot 'build.rsp'
[IO.File]::WriteAllLines($responsePath, $arguments, [Text.UTF8Encoding]::new($true))
& $compilerPath ('@' + $responsePath)
if ($LASTEXITCODE -ne 0) { throw 'ビルドに失敗しました。' }
Write-Host ('作成しました：' + (Join-Path $releasePath 'Pochi.exe'))
if ($Test) {
    $testData = Join-Path $projectRoot 'test-artifacts/domain'
    $testProcess = Start-Process -FilePath (Join-Path $releasePath 'Pochi.exe') -ArgumentList @('--self-test','--data-dir',('"' + $testData + '"')) -WindowStyle Hidden -Wait -PassThru
    Get-Content -LiteralPath (Join-Path $testData 'test-results.json') -Raw
    if ($testProcess.ExitCode -ne 0) { throw '自動テストに失敗しました。' }
}
