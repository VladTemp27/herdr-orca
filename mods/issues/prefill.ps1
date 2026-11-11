# Windows counterpart of prefill.sh: pastes an issue task into the Claude the worktree dialog
# starts, without pressing Enter. `prefill.ps1 <data> <target>`: task and checkout as URI-encoded
# JSON (issue titles come from strangers: data, never script). It starts hidden and returns, then
# gives up after 10 minutes (dialog cancelled). Run with -File.
param([string]$Data, [string]$Target, [long]$Since)
if (-not $Target) { exit 1 }
if (-not $Since) {
  # Taken here, before the dialog makes the terminal, so a slow start can't miss it.
  $Since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $Data, $Target, $Since
  exit
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$task = [Uri]::UnescapeDataString($Data) | ConvertFrom-Json
$folder = [Uri]::UnescapeDataString($Target) | ConvertFrom-Json
if (-not $folder) { exit 1 }
$folder = $folder.Replace("\", "/").TrimEnd("/")
$mark = [char]0x276F # Claude's input line. Written as a code: PowerShell 5.1 misreads this file's non-ASCII.
$end = (Get-Date).AddMinutes(10)
$old = @{}

# Claude's empty input line, past the folder-trust prompt (which uses the same mark).
function Ready($t) {
  $screen = (& hc read $t --lines 20 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $screen -match 'trust this folder|Enter to confirm') { return $false }
  return $screen -match "(?m)^$mark"
}

while ((Get-Date) -lt $end) {
  Start-Sleep 1
  # ForEach-Object: `.terminals.address` would be the .NET array's own Address method.
  foreach ($t in ((& hc ls --json | ConvertFrom-Json).terminals | ForEach-Object address)) {
    if ($old[$t]) { continue }
    $info = & hc get $t --json 2>$null | ConvertFrom-Json
    if (-not $info) { continue }
    # Terminals that existed before this run are checked once, then skipped.
    if ($info.created_ms -lt $Since) { $old[$t] = $true; continue }
    # By the command that started it: herdr-core names the shell as the foreground on Windows,
    # and Herdr starts Claude through PowerShell.
    if (-not $info.labels.'herdr.space' -or "$($info.argv)" -notmatch '\bclaude\b') { continue }
    if (-not [String]::Equals("$($info.cwd)".Replace("\", "/").TrimEnd("/"), $folder, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ("$($info.cwd)".Replace('\', '/') -notlike '*/.herdr/worktrees/*' -or -not (Ready $t)) { continue }
    $keep = Get-Clipboard -Raw
    Set-Clipboard -Value $task
    $null = & herdr-app do pane.focus --terminal $t
    # terminal.paste writes to whatever has focus: never a terminal this didn't just focus.
    if ($LASTEXITCODE -eq 0) { $null = & herdr-app do terminal.paste }
    Start-Sleep 1
    if ($keep) { Set-Clipboard -Value $keep }
    exit
  }
}
