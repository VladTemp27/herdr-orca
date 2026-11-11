# Windows stand-in for `ps -axo pid=,ppid=,pcpu=,rss=,comm=`: one `pid ppid pcpu rssKB name`
# line per process, the format measure.js parses. pcpu is a percent of one core, as with ps,
# taken over a 1 s sample. Run by measure.js with -File.
# ponytail: a fresh powershell.exe per tick (~0.5 s CPU); a long-lived sampler if that shows up.
$ErrorActionPreference = 'SilentlyContinue'
function Times {
  $h = @{}
  # Protected processes (System, csrss) refuse TotalProcessorTime: they read as 0.
  foreach ($p in [Diagnostics.Process]::GetProcesses()) { $h[$p.Id] = $p.TotalProcessorTime.Ticks }
  $h
}
$a = Times
$clock = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 1000
$b = Times
$elapsed = $clock.Elapsed.Ticks
$inv = [Globalization.CultureInfo]::InvariantCulture
foreach ($w in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize) {
  $id = [int]$w.ProcessId
  if ($id -eq $PID) { continue } # not the sampler itself
  $cpu = 0
  if ($a[$id] -and $b[$id]) { $cpu = [Math]::Max(0, 100 * ($b[$id] - $a[$id]) / $elapsed) }
  [string]::Format($inv, '{0} {1} {2:0.0} {3} {4}', $id, $w.ParentProcessId, $cpu, [int64]($w.WorkingSetSize / 1024), ($w.Name -replace '\.exe$', ''))
}
