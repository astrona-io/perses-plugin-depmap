<#
.SYNOPSIS
  depmap-snapshot.ps1: one snapshot of this Windows server's TCP connections, written as Prometheus
  metrics for windows_exporter's textfile collector. The Windows counterpart of depmap-snapshot.sh;
  same metric, same labels.

.DESCRIPTION
  Reads Get-NetTCPConnection and never opens a connection itself. Writes

    depmap_connection_seen{src_host, src_ip, src_process, dst_ip, dst_port, direction} 1

  direction="out": this server called dst_ip:dst_port. direction="in": dst_ip called this server on
  its listening port dst_port. A connection stays in the file for -Retain seconds after it was last
  seen, so a short job between two snapshots is still scraped.

  Install (as Administrator):
    .\depmap-snapshot.ps1 -Install      copies itself to C:\ProgramData\depmap and registers a
                                        scheduled task that runs it every minute as SYSTEM
    .\depmap-snapshot.ps1 -Remove       removes the task, the copy and the output file

.NOTES
  Needs Windows Server 2012 R2 or newer (NetTCPIP module) and windows_exporter with the textfile
  collector enabled (it is by default; the directory below is its default).
#>
[CmdletBinding()]
param(
  [string]$TextFile = "C:\Program Files\windows_exporter\textfile_inputs\depmap.prom",
  [string]$State = "C:\ProgramData\depmap\state.tsv",
  [int]$Retain = 300,
  [string]$HostName = $env:COMPUTERNAME.ToLowerInvariant(),
  [int[]]$IgnorePorts = @(3389, 9182),
  [switch]$Install,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$TaskName = "depmap-snapshot"
$InstallDir = "C:\ProgramData\depmap"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  Remove-Item -Force $TextFile -ErrorAction SilentlyContinue
  Write-Output "depmap-snapshot removed."
  return
}

if ($Install) {
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  Copy-Item -Force $PSCommandPath "$InstallDir\depmap-snapshot.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$InstallDir\depmap-snapshot.ps1`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
  Write-Output "Scheduled task '$TaskName' runs every minute; output: $TextFile"
  return
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$listening = @{}
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $listening[[int]$_.LocalPort] = $true }
$names = @{}
Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }

function Clean([string]$ip) { return ($ip -replace '^::ffff:', '') }
function Esc([string]$s) { return ($s -replace '\\', '\\\\' -replace '"', '\"') }

$seen = @{}
if (Test-Path $State) {
  foreach ($line in Get-Content $State) {
    $parts = $line -split "`t"
    if ($parts.Count -eq 2 -and ($now - [long]$parts[1]) -le $Retain) { $seen[$parts[0]] = [long]$parts[1] }
  }
}

foreach ($c in Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue) {
  $local = Clean $c.LocalAddress
  $peer = Clean $c.RemoteAddress
  if ($local -match '^127\.' -or $local -eq '::1' -or $peer -match '^127\.' -or $peer -eq '::1') { continue }
  if ($IgnorePorts -contains [int]$c.LocalPort) { continue }
  $proc = Esc ($names[[int]$c.OwningProcess])
  if ($listening.ContainsKey([int]$c.LocalPort)) {
    $key = "src_host=`"$HostName`",src_ip=`"$local`",src_process=`"$proc`",dst_ip=`"$peer`",dst_port=`"$($c.LocalPort)`",direction=`"in`""
  } else {
    $key = "src_host=`"$HostName`",src_ip=`"$local`",src_process=`"$proc`",dst_ip=`"$peer`",dst_port=`"$($c.RemotePort)`",direction=`"out`""
  }
  $seen[$key] = $now
}

New-Item -ItemType Directory -Force (Split-Path $State) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $TextFile) | Out-Null
($seen.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)`t$($_.Value)" }) | Set-Content -Encoding ascii $State

$out = New-Object System.Collections.Generic.List[string]
$out.Add("# HELP depmap_connection_seen 1 while a TCP connection of this kind was seen in the last Retain seconds.")
$out.Add("# TYPE depmap_connection_seen gauge")
foreach ($k in ($seen.Keys | Sort-Object)) { $out.Add("depmap_connection_seen{$k} 1") }
$out.Add("# HELP depmap_snapshot_last_run_timestamp_seconds When depmap-snapshot.ps1 last ran.")
$out.Add("# TYPE depmap_snapshot_last_run_timestamp_seconds gauge")
$out.Add("depmap_snapshot_last_run_timestamp_seconds{src_host=`"$HostName`"} $now")
# windows_exporter wants LF line endings and no BOM; write to a temp file and rename (atomic).
$tmp = "$TextFile.tmp"
[System.IO.File]::WriteAllText($tmp, (($out -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
Move-Item -Force $tmp $TextFile
