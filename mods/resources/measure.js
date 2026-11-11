// CPU and memory of every local Herdr terminal's process tree, by space, plus Herdr itself.
import { exec, hc, appHome, window } from "herdr";

const local = (address) => !address.includes("/");
const base = (comm) => comm.split("/").pop() || comm;

// Windows has no `ps -o`: procs.ps1 prints the same columns.
const listProcs = () => window()?.platform === "windows"
  ? exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/resources/procs.ps1`])
  : exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="]);

// `ps -axo pid=,ppid=,pcpu=,rss=,comm=`: comm is last and may hold spaces.
function parsePs(out) {
  const procs = new Map();
  const kids = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const p = { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4], comm: m[5] };
    procs.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  return { procs, kids };
}

// Sums a tree from `root`, skipping pids already claimed (a terminal inside Herdr's own tree).
function sumTree(root, { procs, kids }, claimed) {
  const acc = { cpu: 0, rss: 0, top: null };
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    const p = procs.get(pid);
    if (!p || claimed.has(pid)) continue;
    claimed.add(pid);
    acc.cpu += p.cpu;
    acc.rss += p.rss;
    if (!acc.top || p.rss > acc.top.rss) acc.top = { name: base(p.comm), rss: p.rss };
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return acc;
}

const add = (a, b) => {
  a.cpu += b.cpu;
  a.rss += b.rss;
  if (b.top && (!a.top || b.top.rss > a.top.rss)) a.top = b.top;
};

export class Meter {
  constructor(cache = {}) {
    this.info = new Map(Object.entries(cache)); // address -> { pid, space, parent, name }
  }

  cache() {
    return Object.fromEntries(this.info);
  }

  async lookup(address) {
    const r = await hc(["get", "--json", address]).catch(() => null);
    if (r?.code !== 0) return;
    try {
      const j = JSON.parse(r.stdout);
      this.info.set(address, { pid: j.pid ?? null, space: j.labels?.["herdr.space"] ?? null, tab: j.labels?.["herdr.tab"] ?? null, parent: j.parent ?? null, name: j.foreground?.name ?? null });
    } catch {}
  }

  spaceOf(address, seen = new Set()) {
    const i = this.info.get(address);
    if (!i || seen.has(address)) return null;
    seen.add(address);
    return i.space ?? (i.parent ? this.spaceOf(i.parent, seen) : null);
  }

  // terms: terminals() (address, state, program); spaceList: spaces().
  async measure(terms, spaceList, cores) {
    const live = terms.filter((t) => local(t.address) && (t.state ?? "live") === "live");
    const ps = parsePs((await listProcs()).stdout);
    const addrs = new Set(live.map((t) => t.address));
    for (const a of this.info.keys()) if (!addrs.has(a)) this.info.delete(a);
    // New terminal, or its shell is gone (a lost terminal gets a new one at the same address).
    for (const t of live) {
      const i = this.info.get(t.address);
      if (!i || !ps.procs.has(i.pid)) await this.lookup(t.address);
    }

    const names = new Map(spaceList.map((s) => [s.id, s.name]));
    const tabs = new Map(spaceList.flatMap((s) => (s.tabs ?? []).map((t) => [t.id, t.named ? t.name : `Tab ${t.name}`])));
    const claimed = new Set();
    const bySpace = new Map();
    for (const t of live) {
      const i = this.info.get(t.address);
      const space = this.spaceOf(t.address);
      if (!i?.pid || !space) continue;
      const s = sumTree(i.pid, ps, claimed);
      const parentTab = i.parent && this.info.get(i.parent)?.tab;
      const where = tabs.get(i.tab ?? parentTab) ?? null;
      const row = { address: t.address, name: t.program?.name ?? i.name ?? t.address, fg: i.name, where, ...s };
      if (!bySpace.has(space)) bySpace.set(space, { cpu: 0, rss: 0, top: null, terms: [] });
      const g = bySpace.get(space);
      add(g, s);
      g.terms.push(row);
    }

    // Herdr's window and herdr-core, minus the terminals already counted.
    const app = { cpu: 0, rss: 0, top: null };
    for (const p of ps.procs.values()) {
      if (/\/Herdr\.app\/Contents\/MacOS\/|herdr-core|herdr-app$/.test(p.comm)) add(app, sumTree(p.pid, ps, claimed));
    }

    const pct = (cpu) => cpu / Math.max(1, cores);
    const norm = (x) => ({ ...x, cpu: pct(x.cpu) });
    const spaces = [...bySpace].map(([id, g]) => ({
      id, name: names.get(id) ?? id, ...norm(g),
      terms: g.terms.map(norm).sort((a, b) => b.rss - a.rss),
    })).sort((a, b) => b.rss - a.rss);
    const total = { cpu: pct(app.cpu), rss: app.rss };
    for (const s of spaces) { total.cpu += s.cpu; total.rss += s.rss; }
    return { total, app: norm(app), spaces, at: Date.now() };
  }
}
