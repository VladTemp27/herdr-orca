# Windows sender for desktop-notifications: `toast.ps1 post|clear <data>`, where data is
# URI-encoded JSON { aumid, tag (the terminal), title?, subtitle?, body?, icon? }. Text arrives
# as data, never as script, and is XML-escaped. Silent: Herdr plays its own sound. Clicking it
# focuses the agent (click.js). Run with -File.
param([string]$Action, [string]$Data)
$ErrorActionPreference = 'Stop'
$n = [Uri]::UnescapeDataString($Data) | ConvertFrom-Json
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$group = 'herdr-agent'
if ($Action -eq 'clear') {
  [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($n.tag, $group, $n.aumid)
  exit
}
# Windows drops toasts from an app id it doesn't know, and Herdr's installer registers none:
# this one is registered (per user) as "Herdr", with Herdr's icon.
$key = "HKCU:\Software\Classes\AppUserModelId\$($n.aumid)"
if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
Set-ItemProperty -LiteralPath $key -Name DisplayName -Value 'Herdr'
if ($n.icon) { Set-ItemProperty -LiteralPath $key -Name IconUri -Value $n.icon }
# A click opens herdr-agent:<terminal>, handled (per user) by click.js through wscript, which
# shows no console window. It points at the running Herdr, so it follows the app if it moves.
$herdr = (Get-Process herdr-app -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path
if ($herdr) {
  $link = 'HKCU:\Software\Classes\herdr-agent'
  $null = New-Item -Path "$link\shell\open\command" -Force
  Set-ItemProperty -LiteralPath $link -Name '(default)' -Value 'URL:Herdr agent'
  Set-ItemProperty -LiteralPath $link -Name 'URL Protocol' -Value ''
  $click = Join-Path $PSScriptRoot 'click.js'
  Set-ItemProperty -LiteralPath "$link\shell\open\command" -Name '(default)' -Value "`"$env:SystemRoot\System32\wscript.exe`" //B //Nologo `"$click`" `"$herdr`" `"%1`""
}
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$texts = @($n.title, $n.subtitle, $n.body) | Where-Object { $_ } | ForEach-Object { '<text>' + [Security.SecurityElement]::Escape([string]$_) + '</text>' }
$launch = [Security.SecurityElement]::Escape('herdr-agent:' + $n.tag)
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast activationType="protocol" launch="' + $launch + '"><visual><binding template="ToastGeneric">' + ($texts -join '') + '</binding></visual><audio silent="true"/></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $n.tag
$toast.Group = $group
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($n.aumid).Show($toast)
