// node mods/issues/check.mjs: the worktree dialog starts the right prefill helper for each
// platform and, on Windows, prefill.ps1 pastes only into the new Claude once it's past the trust
// prompt, with the task as data. hc, herdr-app and clipboard operations use stand-ins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calls = [], copied = [];
let platform;
const known = { View: class {}, exec: async (...a) => (calls.push(a), { code: 0 }), window: () => ({ platform }), appHome: () => "H:/app" };
globalThis.stub = new Proxy({}, { get: (_, k) => known[k] ?? (() => {}) });
const src = readFileSync(new URL("../new-worktree/main.js", import.meta.url), "utf8")
  .replace(/^import (\{[^}]*\}) from "[^"]+";\r?$/gm, "const $1 = globalThis.stub;");
const { default: Dialog } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
const tree = "C:\\x\\.herdr\\worktrees\\a";
const prefill = (on, task) => Dialog.prototype.prefill.call({ on }, task, { write_to_clipboard: (t) => copied.push(t) }, tree);

const task = `issue "x'; calc; $(calc) <&> \u00e9`;
platform = "windows";
await prefill(null, task);
assert.deepEqual(calls.pop(), ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "H:/app/mods/issues/prefill.ps1", encodeURIComponent(JSON.stringify(task)), encodeURIComponent(JSON.stringify(tree))]]);
platform = "macos";
await prefill(null, task);
assert.equal(calls.pop()[1][2], "H:/app/mods/issues/prefill.sh");
await prefill("vps", task);
assert.deepEqual([calls.length, copied], [0, [task]]);

if (process.platform === "win32") {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(`${tmpdir()}/herdr-prefill-`);
  const put = (name, text) => writeFileSync(`${dir}/${name}`, text);
  const log = () => (existsSync(`${dir}/log.txt`) ? readFileSync(`${dir}/log.txt`, "utf8").trim().split(/\r?\n/) : []);
  const since = Date.now();
  const claude = ["powershell.exe", "-NoExit", "-Command", "& 'claude'"], labels = { "herdr.space": "s" };
  const rows = {
    t1: { created_ms: since - 5000, argv: claude, cwd: tree, labels }, // older than this run
    t2: { created_ms: since + 1, argv: ["powershell.exe"], cwd: tree, labels }, // not Claude
    t3: { created_ms: since + 1, argv: claude, cwd: "C:\\x\\other", labels }, // not a worktree
    other: { created_ms: since + 1, argv: claude, cwd: `${tree}-other`, labels }, // concurrent, different checkout
    t4: { created_ms: since + 1, argv: claude, cwd: tree, labels },
  };
  for (const [address, row] of Object.entries(rows)) put(`${address}.json`, JSON.stringify(row));
  put("ls.json", JSON.stringify({ terminals: Object.keys(rows).map((address) => ({ address })) }));
  put("hc.cmd", '@echo off\r\nif "%1"=="ls" type "%~dp0ls.json"\r\nif "%1"=="get" type "%~dp0%2.json"\r\nif "%1"=="read" type "%~dp0screen.txt" & copy /y "%~dp0ready.txt" "%~dp0screen.txt" >nul\r\n');
  const script = fileURLToPath(new URL("./prefill.ps1", import.meta.url));
  put("wrapper.ps1", `param([string]$Data, [string]$Target, [long]$Since)
$global:clipboard = 'original clipboard'
function Get-Clipboard { $global:clipboard }
function Set-Clipboard {
  param($Value)
  $global:clipboard = $Value
  [IO.File]::WriteAllText('${dir}/clipboard.txt', $Value)
}
function herdr-app {
  [IO.File]::AppendAllText('${dir}/log.txt', ($args -join ' ') + [Environment]::NewLine)
  $global:LASTEXITCODE = 0
  if ($args[1] -eq 'pane.focus' -and $env:CHECK_NO_FOCUS) { $global:LASTEXITCODE = 1; return }
  if ($args[1] -eq 'terminal.paste') { [IO.File]::WriteAllText('${dir}/pasted.txt', $global:clipboard) }
}
& '${script.replaceAll("'", "''")}' $Data $Target $Since
`);
  put("ready.txt", "\u276f\u00a0Try it\r\n");
  const run = (env = {}) => {
    rmSync(`${dir}/log.txt`, { force: true });
    put("screen.txt", "\u276f No, exit\r\n  Yes, I trust this folder\r\n");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${dir}/wrapper.ps1`, encodeURIComponent(JSON.stringify(task)), encodeURIComponent(JSON.stringify(tree)), String(since)], { env: { ...process.env, ...env, PATH: `${dir};${process.env.PATH}` }, timeout: 30000 });
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(readFileSync(`${dir}/clipboard.txt`, "utf8"), "original clipboard", "mock clipboard restored");
  };
  try {
    run();
    assert.deepEqual(log(), ["do pane.focus --terminal t4", "do terminal.paste"]);
    assert.equal(readFileSync(`${dir}/pasted.txt`, "utf8").replace(/^\uFEFF/, "").trim(), task);
    run({ CHECK_NO_FOCUS: "1" });
    assert.deepEqual(log(), ["do pane.focus --terminal t4"]); // focus failed: no paste
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log("issues check passed");
