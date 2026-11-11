// Safe regression checks: Herdr calls are mocked; only short Node examples and scratch files run.
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const UUID = "01a1abbf-504f-77e3-84d7-2a3fc14303fe";
const OTHER = "02a1abbf-504f-77e3-84d7-2a3fc14303fe";
const START = "2026-11-12T01:00:00.0000000Z";
const shell = (address, pid) => ({ address, pid, state: "live", labels: { "herdr.space": "space" }, foreground: { pid, name: "powershell.exe", argv: ["powershell.exe"], cwd: "C:\\it's here" } });
let platform = "windows";
let rows = [];
let sessionResult = UUID;
const calls = [];
const notices = [];
globalThis.herdr = {
  window: () => ({ platform }), home: () => "C:\\Users\\x", appHome: () => "C:\\app",
  readTextFile: async () => null,
  hc: async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(shell(args[2], args[2] === "t1" ? 100 : 300)) };
  },
  exec: async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: args.includes("-File") ? sessionResult : args.at(-1).includes("Get-ChildItem") ? `rollout-${OTHER}.jsonl` : JSON.stringify(rows) };
  },
};
const raw = readFileSync(new URL("./core.js", import.meta.url), "utf8");
let revision = 0;
const load = () => import(`data:text/javascript,${encodeURIComponent(raw.replace(/^import (.*) from "herdr";$/m, "const $1 = globalThis.herdr;") + `\n// ${revision++}`)}`);
const child = (line, pid = 200, parent = 100) => ({ ProcessId: pid, ParentProcessId: parent, Name: "codex.exe", CommandLine: line, StartedAt: START });
const cases = [];
async function check(name, body) {
  try { await body(); console.log(`PASS ${name}`); }
  catch (error) { cases.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

await check("Windows argv keeps escaped quotes and runs the same Node expression", async () => {
  rows = [child('"C:\\Program Files\\nodejs\\node.exe" -e "console.log(\\"ready\\")"')];
  const core = await load();
  const e = await core.describe(await core.get("t1"));
  assert.deepEqual(e.argv, ["C:\\Program Files\\nodejs\\node.exe", "-e", 'console.log("ready")']);
  const example = spawnSync(process.execPath, e.argv.slice(1), { encoding: "utf8", windowsHide: true });
  assert.equal(example.status, 0, example.stderr);
  assert.equal(example.stdout.trim(), "ready");
});
await check("Windows argv preserves empty arguments, whitespace, and slash/quote parity", async () => {
  const expected = ["node.exe", "", "a b", "C:\\folder with spaces\\", 'a\\"b', 'a"b', "one\ttwo", 'say "yes"'];
  // Independent Windows quoting encoder; the production decoder must reverse it.
  const quote = (arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  rows = [child(expected.map(quote).join(" \t"))];
  const core = await load();
  assert.deepEqual((await core.get("t1")).foreground.argv, expected);
});
await check("Codex launcher normalizes after Windows decoding", async () => {
  rows = [child('"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\codex.js" --model o3')];
  const core = await load();
  const e = await core.describe(await core.get("t1"));
  assert.deepEqual([e.kind, e.session, e.argv], ["codex", UUID, ["codex", "--model", "o3"]]);
  assert.equal(core.commandLine(e), `Set-Location -LiteralPath 'C:\\it''s here'; if ($?) { & { $PSNativeCommandArgumentPassing = 'Legacy'; & 'codex' 'resume' '--no-daemon' '--model' 'o3' '${UUID}' } }`);
  rows = [{ ProcessId: 350, ParentProcessId: 300, Name: "OpenConsole.exe", CommandLine: "OpenConsole.exe" }];
  assert.ok(core.idleShell(await (await load()).get("t2")));
});
await check("same-folder Codex processes use process-specific ownership, never newest cwd", async () => {
  rows = [child('codex.exe'), child('codex.exe', 400, 300)];
  const core = await load();
  sessionResult = UUID;
  const a = await core.describe(await core.get("t1"));
  sessionResult = OTHER;
  const b = await core.describe(await core.get("t2"));
  assert.deepEqual([a.session, b.session], [UUID, OTHER]);
  const probes = calls.filter((args) => args.includes("-File"));
  assert.ok(probes.some((args) => args.includes("200") && args.includes(START)), "lookup needs PID and process creation time");
  assert.ok(probes.some((args) => args.includes("400") && args.includes(START)));
});
await check("unresolved Windows Codex cannot stop, wake, or select --last", async () => {
  sessionResult = "";
  rows = [child(`codex.exe resume ${UUID}`)]; // argv can be stale after /new.
  const core = await load();
  const e = await core.describe(await core.get("t1"));
  assert.equal(e.session, null);
  const before = calls.length;
  assert.equal(await core.stop({ sleep: async () => {} }, e), false);
  assert.equal(await core.start(e), false);
  assert.equal(calls.length, before, "unresolved identity must not send keys, stop, or run anything");
  assert.throws(() => core.resumeArgv(e), /session/i);
});
await check("verified single-agent Windows wake retains its specific conversation", async () => {
  rows = [];
  const core = await load();
  const e = { address: "t1", kind: "codex", argv: ["codex"], session: UUID, processStartedAt: START, cwd: "C:\\repo" };
  const before = calls.length;
  assert.equal(await core.start(e), true);
  const send = calls.slice(before).find((args) => args[0] === "send");
  assert.ok(send?.[2].includes(UUID));
  assert.ok(!send[2].includes("--last"));
});
await check("POSIX open-rollout identity and sh resume stay unchanged", async () => {
  platform = "macos";
  sessionResult = UUID;
  const oldExec = globalThis.herdr.exec;
  globalThis.herdr.exec = async (cmd) => ({ code: 0, stdout: cmd === "lsof" ? `n/tmp/rollout-${UUID}.jsonl\n` : "" });
  const core = await load();
  const e = await core.describe({ ...shell("t1", 100), foreground: { pid: 200, argv: ["codex", "--model", "o3"], cwd: "/tmp/x" } });
  assert.equal(e.session, UUID);
  assert.equal(core.commandLine(e), `cd /tmp/x && codex resume --no-daemon --model o3 ${UUID}`);
  assert.equal(core.commandLine(e, "pwsh"), `Set-Location -LiteralPath '/tmp/x'; if ($?) { & 'codex' 'resume' '--no-daemon' '--model' 'o3' '${UUID}' }`);
  globalThis.herdr.exec = oldExec;
  platform = "windows";
});

// Exercise real Sleep/resume callers while replacing platform IO and UI imports.
await check("Sleep leaves all terminals and state untouched when a Codex session is unknown", async () => {
  const core = await load();
  globalThis.hibernateCore = core;
  globalThis.hibernateMain = {
    spaces: () => [{ id: "space", name: "Work", tabs: [] }], machines: () => [{ name: null, layout: "ready" }],
    notify: (n) => notices.push(n),
  };
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8")
    .replace(/^import \{ View, div \} from "gpui-kit";$/m, "const View = class {}; const div = () => ({});")
    .replace(/^import .* from "herdr";$/m, "const { spaces, machines, notify } = globalThis.hibernateMain;")
    .replace(/^import \* as fs from "fs\/promises";$/m, "")
    .replace(/^import (.*) from "\.\/core.js";$/m, "const $1 = globalThis.hibernateCore;")
    .replace(/^import .* from "\.\/(ui|settings).js";$/gm, "");
  const { default: Hibernate } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  globalThis.Hibernate = Hibernate;
  const h = new Hibernate();
  h.state = { sleeping: {}, rolling: { at: 0, items: {} }, pending: [] };
  h.spaceTerminals = async () => [{ ...shell("t1", 100), foreground: { pid: 200, argv: ["codex"], cwd: "C:\\repo" } }];
  h.save = async () => { throw new Error("unsafe state save"); };
  h.publish = () => { throw new Error("unsafe publish"); };
  sessionResult = "";
  const before = calls.length;
  await h.sleep({ sleep: async () => {} }, "space", true);
  assert.deepEqual(h.state.sleeping, {});
  assert.equal(calls.slice(before).filter((args) => ["keys", "interrupt", "taskkill"].includes(args[0])).length, 0);
  assert.match(notices.at(-1)?.body ?? "", /running|resume/i);
});

await check("legacy Windows Codex snapshots remain saved with an actionable warning", async () => {
  const Hibernate = globalThis.Hibernate;
  const h = new Hibernate();
  const legacy = { address: "t1", shellPid: 100, kind: "codex", argv: ["codex"], cwd: "C:\\repo", session: UUID };
  h.state = { sleeping: { space: { name: "Work", items: [legacy] } }, pending: [legacy], offer: null };
  h.settings = { after_restart: "ask" };
  h.offered = new Set();
  h.toWake = new Set();
  h.stillPending = async () => h.state.pending;
  h.save = async () => { throw new Error("unsafe snapshot removal"); };
  for (const action of [() => h.wake("space"), () => h.offer(), () => h.answer({ resume: ["t1"] })]) {
    await action();
    assert.equal(h.state.pending[0], legacy);
    assert.equal(h.state.sleeping.space.items[0], legacy);
    assert.match(notices.at(-1)?.body ?? "", /session.id|resume/i);
  }
});
await check("session ownership changes are rechecked before any stop keys", async () => {
  platform = "windows";
  rows = [child("codex.exe")];
  sessionResult = UUID;
  const core = await load();
  const e = await core.describe(await core.get("t1"));
  sessionResult = OTHER;
  const before = calls.length;
  assert.equal(await core.stop({ sleep: async () => {} }, e), false);
  assert.equal(calls.slice(before).filter((args) => ["keys", "interrupt", "taskkill"].includes(args[0])).length, 0);
});
await check("PowerShell wake preserves native argv including quotes and empty arguments", async () => {
  if (process.platform !== "win32") return;
  const core = await load();
  const expected = ["", "a b", "C:\\folder with spaces\\", 'a\\"b', 'a"b', "one\ttwo", 'say "yes"'];
  const e = { address: "t1", kind: "program", cwd: tmpdir(), argv: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...expected] };
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", core.commandLine(e, shell === "pwsh.exe" ? "pwsh" : "powershell")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    if (r.error?.code === "ENOENT" && shell === "pwsh.exe") { console.log("SKIP pwsh.exe unavailable"); continue; }
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), expected, shell);
  }
});
await check("native Windows rollout ownership is process-specific and fails closed", async () => {
  if (process.platform !== "win32") return;
  const scratch = mkdtempSync(join(tmpdir(), "hibernate-check-"));
  const children = [];
  try {
    const executable = join(scratch, "codex.exe");
    copyFileSync(process.execPath, executable);
    const script = join(scratch, "hold.cjs");
    writeFileSync(script, `const fs = require("node:fs"); let fd = fs.openSync(process.argv[2], "a"); console.log("ready"); process.stdin.on("data", data => { fs.closeSync(fd); fd = fs.openSync(data.toString().trim(), "a"); console.log("switched"); }); process.stdin.on("end", () => { fs.closeSync(fd); process.exit(0); });`);
    const files = [UUID, OTHER].map((id) => join(scratch, `rollout-${id}.jsonl`));
    for (const file of files) writeFileSync(file, JSON.stringify({payload:{cwd:scratch}}) + "\n");
    for (const file of files) {
      const child = spawn(executable, [script, file], { cwd: scratch, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      await once(child.stdout, "data");
    }
    const powershell = (args) => {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8", windowsHide: true, timeout: 30000 });
      assert.ifError(r.error);
      return r;
    };
    const started = (pid) => {
      const r = powershell(["-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')`]);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const probe = (pid, at = started(pid), root = scratch) => powershell(["-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./codex-session.ps1", import.meta.url)), "-ProcessId", String(pid), "-StartedAt", at, "-SessionRoot", root, "-Cwd", scratch]);
    for (const [i, child] of children.entries()) {
      const r = probe(child.pid);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), [UUID, OTHER][i], r.stderr);
    }
    assert.equal(probe(children[0].pid, START).stdout.trim(), "", "a reused PID / wrong start time must not match");
    assert.equal(probe(process.pid).stdout.trim(), "", "two Codex descendants are ambiguous");
    // Original argv remains unchanged while the current open rollout changes.
    children[0].stdin.write(files[1] + "\n");
    await once(children[0].stdout, "data");
    assert.equal(probe(children[0].pid).stdout.trim(), OTHER);
    assert.notEqual(probe(children[0].pid, started(children[0].pid), join(scratch, "missing")).status, 0);
    for (let i = 0; i < 199; i++) writeFileSync(join(scratch, `rollout-extra-${i}.jsonl`), JSON.stringify({payload:{cwd:join(scratch,"other")}}));
    assert.equal(probe(children[0].pid).stdout.trim(), OTHER, "unrelated historical sessions must not exhaust the bound");
    for (let i = 0; i < 199; i++) writeFileSync(join(scratch, `rollout-extra-${i}.jsonl`), JSON.stringify({payload:{cwd:scratch}}));
    assert.equal(probe(children[0].pid).stdout.trim(), "", "more than 200 same-folder candidate files must fail closed");
  } finally {
    for (const child of children) {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

if (cases.length) throw new Error(`${cases.length} hibernate regression(s) failed: ${cases.join(", ")}`);
console.log("hibernate check passed");
