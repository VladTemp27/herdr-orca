param([uint32]$ProcessId, [string]$StartedAt, [string]$SessionRoot, [string]$Cwd)
$ErrorActionPreference = 'Stop'
try {
    # Match the captured process instance and its current Codex descendants, never a reused PID.
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
    $root = $all | Where-Object ProcessId -eq $ProcessId | Select-Object -First 1
    if (!$root -or !$StartedAt -or $root.CreationDate.ToUniversalTime().ToString('o') -ne $StartedAt) { return }
    $tree = @($root)
    do {
        $more = @($all | Where-Object { $p = $_; !($tree.ProcessId -contains $p.ProcessId) -and @($tree | Where-Object { $_.ProcessId -eq $p.ParentProcessId -and $_.CreationDate -le $p.CreationDate }).Count })
        $tree += $more
    } while ($more.Count)
    $owners = @{}
    foreach ($p in $tree | Where-Object Name -ieq 'codex.exe') {
        $live = Get-Process -Id $p.ProcessId
        $ticks = $live.StartTime.ToUniversalTime().Ticks
        if (($ticks - ($ticks % 10)) -ne $p.CreationDate.ToUniversalTime().Ticks) { return }
        $owners["$($p.ProcessId):$($live.StartTime.ToUniversalTime().ToFileTimeUtc())"] = $true
    }
    if (!$owners.Count) { return }
    # shortcut: at most 200 same-folder rollouts; add a session index if histories exceed this bound.
    # Exceeding the bound fails closed, never picks a subset.
    $folder = [IO.Path]::GetFullPath($Cwd).TrimEnd([char[]]'\/')
    $files = @(Get-ChildItem -LiteralPath $SessionRoot -Recurse -Filter 'rollout-*.jsonl' -File | Where-Object {
        $meta = Get-Content -LiteralPath $_.FullName -TotalCount 1 -Encoding UTF8 | ConvertFrom-Json
        $meta.payload.cwd -and [string]::Equals([IO.Path]::GetFullPath($meta.payload.cwd).TrimEnd([char[]]'\/'), $folder, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 201)
    if ($files.Count -gt 200) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class RolloutOwners {
    [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public FILETIME Start; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct Info {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string App;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public uint Type, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint apps, IntPtr app, uint services, IntPtr service);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] Info[] info, ref uint reasons);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
    public static string[] ForFile(string file) {
        uint h;
        if (RmStartSession(out h, 0, new StringBuilder(33)) != 0) throw new Exception("RmStartSession");
        try {
            if (RmRegisterResources(h, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) throw new Exception("RmRegisterResources");
            uint needed, count = 0, reasons = 0;
            int result = RmGetList(h, out needed, ref count, null, ref reasons);
            if (result == 0) return new string[0];
            if (result != 234) throw new Exception("RmGetList");
            var info = new Info[needed];
            count = needed;
            if (RmGetList(h, out needed, ref count, info, ref reasons) != 0) throw new Exception("RmGetList");
            return info.Take((int)count).Select(p => p.Process.Pid + ":" + (((long)p.Process.Start.dwHighDateTime << 32) | (uint)p.Process.Start.dwLowDateTime)).ToArray();
        } finally { RmEndSession(h); }
    }
}
'@
    $ids = @()
    foreach ($file in $files) {
        $owned = @([RolloutOwners]::ForFile($file.FullName) | Where-Object { $owners.ContainsKey($_) })
        if ($owned.Count -and $file.Name -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$') { $ids += $Matches[1] }
    }
    if ($ids.Count -eq 1) { $ids[0] }
} catch {
    # Missing permissions, files, or native ownership information must leave the agent running.
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
