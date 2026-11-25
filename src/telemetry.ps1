$ErrorActionPreference = 'SilentlyContinue'

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1

$ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$ramUsedGB = [math]::Round($ramTotalGB - $ramFreeGB, 1)
$ramPct = if ($ramTotalGB -gt 0) { [math]::Round(($ramUsedGB / $ramTotalGB) * 100, 1) } else { 0 }

$diskTotalGB = [math]::Round($disk.Size / 1GB, 1)
$diskFreeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
$diskUsedGB = [math]::Round($diskTotalGB - $diskFreeGB, 1)
$diskPct = if ($diskTotalGB -gt 0) { [math]::Round(($diskUsedGB / $diskTotalGB) * 100, 1) } else { 0 }

$uptimeSpan = (Get-Date) - $os.LastBootUpTime
$uptimeHours = [math]::Floor($uptimeSpan.TotalHours)
$uptimeMins = $uptimeSpan.Minutes
$uptimeDays = [math]::Round($uptimeSpan.TotalDays, 1)

$topProcs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object {
  @{
    name = $_.ProcessName
    mb = [math]::Round($_.WorkingSet64 / 1MB, 0)
  }
}

$result = @{
  cpuName = if ($cpu) { $cpu.Name.Trim() } else { "Unknown CPU" }
  cpuLoad = if ($cpu -and $null -ne $cpu.LoadPercentage) { $cpu.LoadPercentage } else { 0 }
  ramTotalGB = $ramTotalGB
  ramUsedGB = $ramUsedGB
  ramFreeGB = $ramFreeGB
  ramPct = $ramPct
  diskTotalGB = $diskTotalGB
  diskUsedGB = $diskUsedGB
  diskFreeGB = $diskFreeGB
  diskPct = $diskPct
  batteryPct = if ($bat) { $bat.EstimatedChargeRemaining } else { $null }
  batteryCharging = if ($bat) { $bat.BatteryStatus -eq 2 } else { $false }
  uptime = "${uptimeHours}h ${uptimeMins}m (~${uptimeDays}d)"
  topProcs = @($topProcs)
}

$result | ConvertTo-Json -Depth 4 -Compress
