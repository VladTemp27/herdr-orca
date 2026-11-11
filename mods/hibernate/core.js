// What runs in a terminal, how to stop it, and how to start it again.
import { hc, exec, home, readTextFile, window, appHome } from "herdr";

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "powershell", "cmd", "login"]);
// Either slash; Windows names lose ".exe".
const base = (s) => String(s ?? "").split(/[\\/]/).pop().replace(/^-/, "").replace(/\.exe$/i, "");
const isShell = (s) => SHELLS.has(base(s));
export const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

const homes = new Map();
async function homeOn(on) {
  if (!on) return home();
  if (!homes.has(on)) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
    if (r.code !== 0 || !r.stdout) throw new Error(`no home on ${on}`);
    homes.set(on, r.stdout);
  }
  return homes.get(on);
}

const windows = () => window()?.platform === "windows";
// A PowerShell string literal (it also takes curly quotes as quotes).
const psq = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
const powershell = (script) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

// Windows: one process list for every call made within a second (a pass reads all terminals at once).
let snapshot = null;
function processes() {
  if (snapshot && Date.now() - snapshot.at < 1000) return snapshot.list;
  const list = powershell("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='StartedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})")
    .then((r) => JSON.parse(r.stdout))
    .catch(() => []);
  snapshot = { at: Date.now(), list };
  return list;
}

// A Windows command line as argv. An agent behind a launcher (node codex.js, cmd /c codex.cmd)
// counts as that agent: ["codex", ...its arguments].
function argvOf(line) {
  line = String(line ?? "");
  const argv = [];
  for (let i = 0; i < line.length;) {
    while (/[ \t]/.test(line[i] ?? "") && i < line.length) i++;
    if (i === line.length) break;
    let arg = "", quoted = false;
    while (i < line.length && (quoted || !/[ \t]/.test(line[i]))) {
      let slashes = 0;
      while (line[i] === "\\") slashes++, i++;
      if (line[i] === '"') {
        arg += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"', i++;
        else if (quoted && line[i + 1] === '"') arg += '"', i += 2;
        else quoted = !quoted, i++;
      } else {
        arg += "\\".repeat(slashes);
        if (i < line.length && (quoted || !/[ \t]/.test(line[i]))) arg += line[i++];
      }
    }
    argv.push(arg);
  }
  const agent = (a) => base(a).replace(/\.(js|cmd|ps1)$/i, "");
  const i = argv.findIndex((a, j) => j > 0 && ["claude", "codex"].includes(agent(a)));
  return i > 0 ? [agent(argv[i]), ...argv.slice(i + 1)] : argv;
}

export async function get(address) {
  const r = await hc(["get", "--json", address]).catch(() => null);
  if (!r || r.code !== 0) return null;
  let g;
  try {
    g = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  // Windows: the core names the shell as the foreground even while it runs a program,
  // so that program is the shell's child (not its console host).
  const f = g.foreground;
  if (windows() && !machineOf(address) && g.state === "live" && f?.pid === g.pid && isShell(f.argv?.[0] ?? f.name)) {
    const kid = (await processes()).find((p) => p.ParentProcessId === g.pid && !/^(conhost|OpenConsole)\.exe$/i.test(p.Name));
    if (kid) g.foreground = { pid: kid.ProcessId, name: kid.Name, argv: argvOf(kid.CommandLine), cwd: f.cwd };
  }
  if (windows() && !machineOf(address) && program(g)) {
    const p = (await processes()).find((p) => p.ProcessId === g.foreground.pid);
    g.foreground.startedAt = p?.StartedAt;
  }
  return g;
}

export async function list() {
  const r = await hc(["ls", "--json"]).catch(() => null);
  try {
    return JSON.parse(r?.stdout ?? "").terminals ?? [];
  } catch {
    return [];
  }
}

// The program running in a terminal now, or null for an idle shell.
export function program(g) {
  const f = g?.foreground;
  if (!f || g.state !== "live") return null;
  if (f.pid === g.pid && isShell(f.argv?.[0] ?? f.name)) return null;
  return f;
}

export const idleShell = (g) => g?.state === "live" && !!g.foreground && program(g) === null;

function kind(g, f) {
  const app = g.status?.app;
  const b = base(f.argv?.[0]);
  if (app === "claude-code" || b === "claude") return "claude";
  if (app === "codex" || b === "codex") return "codex";
  return "program";
}

async function claudeSession(pid, on) {
  const text = await readTextFile(`${await homeOn(on)}/.claude/sessions/${pid}.json`, { on }).catch(() => null);
  try {
    return text ? JSON.parse(text).sessionId ?? null : null;
  } catch {
    return null;
  }
}

// The open rollout identifies the current conversation, even after in-app session switches.
async function codexSession(pid, on, startedAt, cwd) {
  if (!on && windows()) {
    if (!startedAt) return null;
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/hibernate/codex-session.ps1`, "-ProcessId", String(pid), "-StartedAt", startedAt, "-SessionRoot", `${home()}/.codex/sessions`, "-Cwd", cwd]).catch(() => null);
    const id = r?.stdout.trim() ?? "";
    return r?.code === 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  }
  const kids = await exec("pgrep", ["-P", String(pid)], { on }).catch(() => null);
  const pids = [String(pid), ...(kids?.stdout ?? "").split(/\s+/).filter(Boolean)];
  const r = await exec("lsof", ["-p", pids.join(","), "-Fn"], { on }).catch(() => null);
  const m = (r?.stdout ?? "").match(/rollout-[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/);
  return m ? m[1] : null;
}

// A snapshot entry for a terminal, or null when it runs nothing.
export async function describe(g) {
  const f = program(g);
  if (!f) return null;
  const k = kind(g, f);
  const on = machineOf(g.address);
  const session = k === "claude" ? await claudeSession(f.pid, on) : k === "codex" ? await codexSession(f.pid, on, f.startedAt, f.cwd || g.cwd) : null;
  return {
    address: g.address,
    shellPid: g.pid,
    processPid: f.pid,
    processStartedAt: f.startedAt,
    argv: f.argv ?? [],
    cwd: f.cwd || g.cwd,
    kind: k,
    session,
    name: k === "claude" ? "Claude Code" : k === "codex" ? "Codex" : base(f.argv?.[0]) || f.name,
    status: g.status?.state ?? null,
    space: g.labels?.["herdr.space"] ?? null,
    tab: g.labels?.["herdr.tab"] ?? null,
    parent: g.parent ?? null,
  };
}

// Never stop or revive Windows Codex using an unverified conversation (including old snapshots).
export const missingCodexSession = (e) => windows() && !machineOf(e.address) && e.kind === "codex" && (!e.session || !e.processStartedAt);

// Flags worth carrying over to a resumed agent.
const KEEP = {
  claude: { flags: ["--dangerously-skip-permissions", "--verbose"], valued: ["--model", "--permission-mode", "--add-dir", "--agent"] },
  codex: { flags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--search"], valued: ["--model", "-m", "--profile", "-p", "--sandbox", "-s"] },
};

function kept(argv, k) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (KEEP[k].flags.includes(argv[i])) out.push(argv[i]);
    else if (KEEP[k].valued.includes(argv[i]) && i + 1 < argv.length) out.push(argv[i], argv[++i]);
  }
  return out;
}

export function resumeArgv(e) {
  if (missingCodexSession(e)) throw new Error("Codex session is unknown; leave it running and record its session ID before exiting.");
  if (e.kind === "claude") return e.session ? ["claude", ...kept(e.argv, "claude"), "--resume", e.session] : e.argv;
  if (e.kind === "codex") return ["codex", "resume", "--no-daemon", ...kept(e.argv, "codex"), e.session ?? "--last"];
  return e.argv;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
// The local script scope selects Legacy on pwsh too, so Windows-encoded empty/quoted arguments work in both versions.
const psNativeArg = (s) => psq(/[ \t"]/.test(s) || s === "" ? '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"' : s);
// What to type into `shell`. PowerShell (Herdr's shell on Windows) has no && in 5.1.
export function commandLine(e, shell = windows() && !machineOf(e.address) ? "powershell" : "sh") {
  const argv = resumeArgv(e);
  if (shell === "powershell" || shell === "pwsh") {
    const invoke = windows() && !machineOf(e.address)
      ? `& { $PSNativeCommandArgumentPassing = 'Legacy'; & ${psq(argv[0])} ${argv.slice(1).map(psNativeArg).join(" ")} }`
      : `& ${argv.map(psq).join(" ")}`;
    return `Set-Location -LiteralPath ${psq(e.cwd)}; if ($?) { ${invoke} }`;
  }
  return `cd ${q(e.cwd)} && ${argv.map(q).join(" ")}`;
}

// A send from another machine reaches a shell that once ran an agent as a tagged message
// (`<hc from=...>`), which the shell can't run: so a remote terminal is typed into from its own machine.
function send(address, text) {
  const on = machineOf(address);
  return on ? exec("hc", ["send", address.slice(on.length + 1), text], { on }) : hc(["send", address, text]);
}

const missing = async (address) => {
  const r = await hc(["get", "--json", address]).catch(() => null);
  return !!r && r.code !== 0 && /"kind":\s*"not_found"/.test(`${r.stdout}${r.stderr}`);
};

// Starts an entry again in its idle shell; never types into a busy one.
export async function start(e) {
  if (missingCodexSession(e)) return false;
  const g = await get(e.address);
  // A failed lookup (machine unreachable) isn't a gone terminal: leave it for the next wake.
  if (!g && !(await missing(e.address))) return false;
  let address = e.address;
  let shell; // a new terminal gets this machine's default shell
  if (!g || g.state !== "live") {
    if (!e.space || !e.tab) return false;
    // Its terminal is gone: a new shell in the same tab.
    const on = machineOf(e.address);
    const r = await hc(["run", "--json", "--bg", "--keep", "--no-parent", ...(on ? ["--on", on] : []), "--cwd", e.cwd, "--label", `herdr.space=${e.space}`, "--label", `herdr.tab=${e.tab}`]).catch(() => null);
    try {
      address = JSON.parse(r?.stdout ?? "").address;
    } catch {
      return false;
    }
    if (!address) return false;
    // A retry types into this shell instead of opening another.
    e.address = address;
  } else if (!idleShell(g)) return false;
  else shell = base(g.foreground.argv?.[0] ?? g.foreground.name);
  const r = await send(address, commandLine(e, shell)).catch(() => null);
  return r?.code === 0;
}

async function waitIdle(cx, address, ms) {
  for (let left = ms; left > 0; left -= 400) {
    await cx.sleep(400);
    const g = await get(address);
    if (g && (g.state !== "live" || idleShell(g))) return true;
  }
  return false;
}

// SIGTERM to the program's process group: ctrl+c (SIGINT) makes Herdr's launcher
// shell (zsh -lic '"$@"; exec "$0" -li') abort instead of returning to its prompt.
// Windows has neither signals nor that launcher: ctrl+c, and PowerShell stays.
async function term(address) {
  const g = await get(address);
  const f = program(g);
  if (!f || f.pid === g.pid) return;
  const on = machineOf(address);
  if (!on && windows()) return void (await hc(["interrupt", address, "--timeout", "5"]).catch(() => null));
  const r = await exec("kill", ["-TERM", `-${f.pid}`], { on }).catch(() => null);
  if (r?.code !== 0) await exec("kill", ["-TERM", String(f.pid)], { on }).catch(() => null);
}

// Stops what runs in a terminal and leaves its shell in place.
export async function stop(cx, e) {
  if (missingCodexSession(e)) return false;
  if (windows() && !machineOf(e.address) && e.kind === "codex") {
    const current = await describe(await get(e.address));
    if (!current || current.session !== e.session || current.shellPid !== e.shellPid || current.processPid !== e.processPid || current.processStartedAt !== e.processStartedAt) return false;
  }
  if (e.kind === "claude" || e.kind === "codex") {
    if (e.status === "working" || e.status === "blocked") await hc(["interrupt", e.address, "--timeout", "5"]).catch(() => null);
    // Pressed as keys: a send from another machine reaches an agent as a tagged message, not a command.
    await hc(["keys", e.address, ...(e.kind === "claude" ? "/exit" : "/quit"), "enter"]).catch(() => null);
    if (await waitIdle(cx, e.address, 10000)) return true;
  }
  await term(e.address);
  if (await waitIdle(cx, e.address, 5000)) return true;
  const g = await get(e.address);
  const f = program(g);
  if (f && f.pid !== g.pid) {
    const on = machineOf(e.address);
    await (!on && windows() ? exec("taskkill", ["/PID", String(f.pid), "/T", "/F"]) : exec("kill", ["-KILL", `-${f.pid}`], { on })).catch(() => null);
  }
  return waitIdle(cx, e.address, 3000);
}
