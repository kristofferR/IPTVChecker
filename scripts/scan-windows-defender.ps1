[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]] $Paths
)

$ErrorActionPreference = "Stop"

$scanPaths = @(
    $Paths |
        ForEach-Object { (Resolve-Path -LiteralPath $_).Path } |
        Sort-Object -Unique
)
if ($scanPaths.Count -eq 0) {
    throw "At least one scan path is required"
}

$preferences = Get-MpPreference
foreach ($excludedPath in @($preferences.ExclusionPath)) {
    if ($excludedPath) {
        Remove-MpPreference -ExclusionPath $excludedPath
    }
}

Set-MpPreference `
    -DisableArchiveScanning $false `
    -DisableBehaviorMonitoring $false `
    -DisableBlockAtFirstSeen $false `
    -DisableIOAVProtection $false `
    -DisableRealtimeMonitoring $false `
    -DisableScriptScanning $false `
    -MAPSReporting Advanced `
    -PUAProtection Enabled `
    -SubmitSamplesConsent SendSafeSamples
Update-MpSignature

$status = Get-MpComputerStatus
$readinessDeadline = [DateTime]::UtcNow.AddSeconds(60)
while (
    $status.AntivirusEnabled -and
    -not $status.RealTimeProtectionEnabled -and
    [DateTime]::UtcNow -lt $readinessDeadline
) {
    Start-Sleep -Seconds 5
    $status = Get-MpComputerStatus
}

$status | Select-Object `
    AMRunningMode, AntivirusEnabled, BehaviorMonitorEnabled, `
    IoavProtectionEnabled, OnAccessProtectionEnabled, `
    RealTimeProtectionEnabled, AntivirusSignatureVersion, `
    AntivirusSignatureLastUpdated
if (-not $status.AntivirusEnabled) {
    throw "Microsoft Defender Antivirus is unavailable"
}
if (-not $status.RealTimeProtectionEnabled) {
    Write-Warning "Real-time protection did not start; continuing with explicit custom scans" `
        -WarningAction Continue
}

$platformRoot = Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"
$mpCmdRun = Get-ChildItem -Path $platformRoot -Filter MpCmdRun.exe -Recurse -File |
    Where-Object { $_.FullName -notmatch "\\X86\\" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $mpCmdRun) {
    throw "MpCmdRun.exe was not found"
}

$failures = @()
foreach ($scanPath in $scanPaths) {
    Write-Host "::group::Microsoft Defender scan: $scanPath"
    $scanOutput = & $mpCmdRun `
        -Scan -ScanType 3 -File $scanPath -DisableRemediation -ReturnHR
    $exitCode = $LASTEXITCODE
    $scanOutput | ForEach-Object { Write-Host $_ }
    Write-Host "MpCmdRun exit code: $exitCode"
    Write-Host "::endgroup::"

    if ($exitCode -ne 0) {
        $failures += [pscustomobject]@{
            Path = $scanPath
            ExitCode = $exitCode
        }
    }
}

if ($failures.Count -gt 0) {
    Get-MpThreatDetection | Format-List | Out-String | Write-Host
    Get-MpThreat | Format-List | Out-String | Write-Host
    $summary = $failures | ConvertTo-Json -Compress
    throw "Microsoft Defender rejected one or more release artifacts: $summary"
}
