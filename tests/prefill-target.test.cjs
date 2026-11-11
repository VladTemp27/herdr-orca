const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const script = path.join(root, 'mods/issues/prefill.ps1');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prefill-test-'));
const folder = 'C:\\Users\\me\\.herdr\\worktrees\\repo-A\\task';
const task = 'Issue "quoted"; $(throw "injected") & `tick`\nnext';
try {
  for (const [mode, shouldPaste] of [['ready', true], ['focus-fails', false], ['trust', false], ['stale', false]]) {
    const wrapper = path.join(temp, 'mock.ps1');
    fs.writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$global:mode = '${mode}'
$global:loops = 0
function Start-Sleep { $global:loops++; if ($global:loops -gt 2) { throw 'test timeout' } }
function hc {
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    'ls' { '{"terminals":[{"address":"wrong"},{"address":"intended"}]}' }
    'get' {
      $cwd = if ($args[1] -eq 'wrong') { 'C:\\Users\\me\\.herdr\\worktrees\\repo-B\\task' } else { '${folder}' }
      $at = if ($global:mode -eq 'stale') { 0 } else { 100 }
      @{ cwd=$cwd; created_ms=$at; argv=@('powershell.exe','claude'); labels=@{'herdr.space'='space'} } | ConvertTo-Json -Compress
    }
    'read' { if ($global:mode -eq 'trust') { 'trust this folder' } else { ([string][char]0x276f) + ' Try it' } }
  }
}
function Get-Clipboard { 'original clipboard' }
function Set-Clipboard { param($Value) @{ clipboard=$Value } | ConvertTo-Json -Compress }
function herdr-app {
  @{ call=($args -join ' ') } | ConvertTo-Json -Compress | Write-Host
  $global:LASTEXITCODE = if ($global:mode -eq 'focus-fails') { 1 } else { 0 }
}
try { & '${script.replaceAll("'", "''")}' '${encodeURIComponent(JSON.stringify(task))}' '${encodeURIComponent(JSON.stringify(folder.toLowerCase().replaceAll('\\', '/')))}' 1 }
catch { if ($_ -notmatch 'test timeout') { throw } }
`);
    const result = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', wrapper], { encoding: 'utf8', timeout: 10000 });
    const events = result.trim().split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
    const calls = events.filter(e => e.call).map(e => e.call);
    assert.ok(!calls.some(c => c.includes('wrong')), mode + ': concurrent folder must never receive task');
    assert.equal(calls.includes('do terminal.paste'), shouldPaste, mode);
    if (mode === 'ready' || mode === 'focus-fails') {
      assert.ok(calls.includes('do pane.focus --terminal intended'));
      assert.equal(events.find(e => 'clipboard' in e).clipboard, task);
      assert.equal(events.at(-1).clipboard, 'original clipboard');
    } else assert.equal(events.length, 0, 'unready/stale terminal must leave clipboard alone');
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
// Capture the dialog's launcher without starting a process or touching a clipboard.
const main = fs.readFileSync(path.join(root, 'mods/new-worktree/main.js'), 'utf8');
const method = main.slice(main.indexOf('  async prefill('), main.indexOf('\n  key(', main.indexOf('  async prefill(')));
const c = { window: () => ({ platform: 'windows' }), appHome: () => '/app', exec: async (...args) => c.calls.push(args), calls: [] };
vm.createContext(c); vm.runInContext(`class Test { ${method} }; this.Test = Test;`, c);
(async () => {
  const view = new c.Test();
  await view.prefill(task, {}, folder);
  const args = c.calls[0][1];
  assert.ok(args.includes(encodeURIComponent(JSON.stringify(task))));
  assert.ok(args.includes(encodeURIComponent(JSON.stringify(folder))));
  assert.ok(main.includes('this.prefill(task, cx, path)'), 'open must supply its requested checkout');
  c.window = () => ({ platform: 'linux' });
  await view.prefill(task, {}, folder);
  assert.equal(c.calls[1][0], 'sh');
  assert.equal(c.calls[1][1].at(-1), task);
  view.on = 'linux-host'; let copied;
  c.notify = () => {};
  await view.prefill(task, { write_to_clipboard: value => { copied = value; } }, '/srv/repo');
  assert.equal(copied, task);
  assert.equal(c.calls.length, 2, 'remote uses clipboard rather than launching a local helper');
  console.log('prefill target tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
