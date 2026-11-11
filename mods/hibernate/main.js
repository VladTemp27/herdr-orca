// hibernate: sleep/wake a space's programs (shells stay) and offer to resume after a reboot
// or core loss. Docked in a 0px block; as an overlay (props.view) it draws its dialogs.

import { View, div } from "gpui-kit";
import { spaces, machines, shared, setShared, notify, openOverlay, closeOverlay, appHome, props, focused, nextCommand, exec, readTextFile, writeTextFile, window } from "herdr";
import * as fs from "fs/promises";
import { get, list, describe, idleShell, start, stop, commandLine, machineOf, missingCodexSession } from "./core.js";
import { SleepDialog, ResumeDialog } from "./ui.js";
import { loadSettings } from "./settings.js";

const DIR = () => `${appHome()}/data/hibernate`;
const FILE = () => `${DIR()}/state.json`;
const LOST_GRACE = 15 * 60 * 1000;
const local = (address) => !String(address).includes("/");
// mod.json `settings` (Mod settings, mod.schema.json): when sleeping spaces wake, and what a restart does.
const DEFAULTS = { wake: "manual", after_restart: "ask" };
const CODEX_SESSION_HELP = "Codex session ownership could not be verified. Record the current session ID in Codex before exiting manually; use codex resume <session-id> to continue it.";
const offline = (id) => machines().find((m) => m.name === machineOf(id))?.layout !== "ready";
const busy = (e) => !e.parent && (e.status === "working" || e.status === "blocked");

export default class Hibernate extends View {
  init(p, cx) {
    this.view = p?.view ?? props()?.view;
    if (this.view === "sleep") return SleepDialog.init(this, cx);
    if (this.view === "resume") return ResumeDialog.init(this, cx);
    this.state = { sleeping: {}, rolling: { at: 0, items: {} }, pending: [] };
    this.settings = DEFAULTS;
    this.lastSpace = focused()?.space ?? null;
    this.queue = [];
    this.running = false;
    this.offered = new Set();
    this.toWake = new Set();
    // Requests already in shared.json were handled by an earlier run.
    this.seen = shared("hibernate.request")?.nonce ?? null;
    this.seenAnswer = shared("hibernate.answer")?.nonce ?? null;
    this.enqueue(cx, async (cx) => {
      await this.load();
      const { settings, problems } = await loadSettings("hibernate", DEFAULTS);
      this.settings = settings;
      for (const problem of problems) console.warn(`hibernate mod.json settings: ${problem}`);
      this.publish();
      await this.noteLaunch();
      await this.pass(cx);
    });
    cx.timer.every(500, (cx) => this.poll(cx));
    cx.timer.every(30000, (cx) => this.enqueue(cx, (cx) => this.pass(cx)));
    // keys.json: "hibernate.sleep" / "hibernate.wake" (focused space), "hibernate.sleep:<space id>",
    // or "hibernate.resume" (everything waiting after a restart).
    cx.spawn(async (cx) => {
      for (;;) {
        const [action, id] = String(await nextCommand()).split(":");
        const space = id || focused()?.space;
        if (action === "resume") this.enqueue(cx, () => this.answer({ resume: this.state.pending.map((p) => p.address) }));
        else if (space && (action === "sleep" || action === "wake")) this.enqueue(cx, (cx) => (action === "sleep" ? this.sleep(cx, space, false) : this.wake(space)));
      }
    });
  }

  async close() {
    if (this.view === "resume") ResumeDialog.close(this);
  }

  // One job at a time, so a sleep never races a snapshot.
  enqueue(cx, job) {
    this.queue.push(job);
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.queue.length) {
          const next = this.queue.shift();
          try {
            await next(cx);
          } catch (e) {
            console.log(`hibernate: ${e?.stack ?? e}`);
          }
        }
      } finally {
        this.running = false;
      }
    });
  }

  poll(cx) {
    // "wake": "open": a sleeping space wakes when you go to it.
    const cur = focused()?.space ?? null;
    if (cur !== this.lastSpace) {
      this.lastSpace = cur;
      if (this.settings.wake === "open" && cur && this.state.sleeping[cur]) this.enqueue(cx, () => this.wake(cur));
    }
    // "wake": "start": each space once its machine is loaded after Herdr starts.
    for (const id of this.toWake) {
      if (!spaces().some((s) => s.id === id) || offline(id)) continue;
      this.toWake.delete(id);
      const at = this.state.sleeping[id]?.at;
      // Its machine may drop before the job runs: then it waits for the next reconnect.
      this.enqueue(cx, () => (this.state.sleeping[id]?.at !== at ? null : offline(id) ? this.toWake.add(id) : this.wake(id)));
    }
    const r = shared("hibernate.request");
    if (r && r.nonce !== this.seen) {
      this.seen = r.nonce;
      if (r.action === "sleep") this.enqueue(cx, (cx) => this.sleep(cx, r.space, !!r.confirmed));
      else if (r.action === "wake") this.enqueue(cx, () => this.wake(r.space));
    }
    const a = shared("hibernate.answer");
    if (a && a.nonce !== this.seenAnswer) {
      this.seenAnswer = a.nonce;
      this.enqueue(cx, () => this.answer(a));
    }
  }

  // Herdr's own start time marks a new launch, so a reload of this mod isn't one.
  async noteLaunch() {
    let launch = null;
    if (window()?.platform === "windows") {
      const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process herdr-app | Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('o')"]).catch(() => null);
      launch = r?.stdout.trim() || null;
    } else {
      const r = await exec("ps", ["-axo", "lstart=,comm="]).catch(() => null);
      const line = (r?.stdout ?? "").split("\n").map((l) => l.trim()).find((l) => /\/Herdr\.app\/Contents\/MacOS\/Herdr$/.test(l));
      launch = line ? line.replace(/\s+\/.*$/, "") : null;
    }
    if (!launch || launch === this.state.launch) return;
    this.state.launch = launch;
    await this.save();
    if (this.settings.wake === "start" && Object.keys(this.state.sleeping).length) this.toWake = new Set(Object.keys(this.state.sleeping));
  }

  // Changes one setting in mod.json; Herdr then reloads this mod with it.
  async setSetting(key, value) {
    const path = `${appHome()}/mods/hibernate/mod.json`;
    const raw = await readTextFile(path);
    const manifest = JSON.parse(raw ?? "{}");
    manifest.settings = { ...(manifest.settings ?? {}), [key]: value };
    await writeTextFile(path, JSON.stringify(manifest, null, 2) + "\n", raw);
  }

  async load() {
    const text = await fs.readFile(FILE(), "utf8").catch(() => null);
    try {
      if (text) this.state = { ...this.state, ...JSON.parse(text) };
      delete this.state.autoResume; // now the after_restart setting
    } catch (e) {
      console.log(`hibernate: unreadable state.json (${e})`);
    }
  }

  async save() {
    await fs.mkdir(DIR(), { recursive: true }).catch(() => {});
    await fs.writeFile(FILE(), JSON.stringify(this.state, null, 1));
  }

  publish() {
    const v = {};
    for (const [id, s] of Object.entries(this.state.sleeping)) v[id] = { at: s.at, count: s.items.filter((e) => !e.parent).length };
    if (JSON.stringify(v) !== JSON.stringify(shared("hibernate.sleeping") ?? {})) setShared("hibernate.sleeping", v);
  }

  // Every terminal belonging to a space, with sub-agents of those.
  async spaceTerminals(space) {
    const tabs = new Set(space.tabs.map((t) => t.id));
    const all = (await Promise.all((await list()).filter((t) => machineOf(t.address) === (space.machine ?? null)).map((t) => get(t.address)))).filter(Boolean);
    // Labels hold their machine's own ids; spaces() prefixes a remote one with the machine.
    const q = (g, id) => (machineOf(g.address) && id ? `${machineOf(g.address)}/${id}` : id);
    const mine = new Set(all.filter((g) => q(g, g.labels?.["herdr.space"]) === space.id || tabs.has(q(g, g.labels?.["herdr.tab"]))).map((g) => g.address));
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of all) if (g.parent && mine.has(g.parent) && !mine.has(g.address)) mine.add(g.address), (grew = true);
    }
    // A parent outside the space (an agent elsewhere started it) won't take it down: it's a program of its own here.
    return all.filter((g) => mine.has(g.address)).map((g) => (g.parent && !mine.has(g.parent) ? { ...g, parent: null } : g));
  }

  async sleep(cx, id, confirmed) {
    const space = spaces().find((s) => s.id === id);
    if (!space) return;
    if (offline(id)) return notify({ title: `${space.name}'s machine is offline`, level: "warning" });
    if (this.state.sleeping[id]) return;
    let entries;
    try {
      entries = (await Promise.all((await this.spaceTerminals(space)).map(describe))).filter(Boolean);
    } catch {
      return notify({ title: `${space.name}: can't reach its machine`, level: "warning" });
    }
    if (!entries.some((e) => !e.parent)) return notify({ title: `Nothing running in ${space.name}`, level: "info" });
    if (entries.some(missingCodexSession)) return notify({ title: `${space.name} is still running`, body: CODEX_SESSION_HELP, level: "warning" });
    const working = entries.filter(busy);
    if (working.length && !confirmed) {
      openOverlay({ mod: "hibernate", kind: "dialog", modal: true, width: 440, height: 230 + 22 * working.length, props: { view: "sleep", space: id, name: space.name, busy: working.map((e) => `${e.name} is ${e.status}`) } });
      return;
    }
    this.state.sleeping[id] = { at: Date.now(), name: space.name, items: entries };
    await this.save();
    this.publish();
    const tops = entries.filter((e) => !e.parent);
    const ok = await Promise.all(tops.map((e) => stop(cx, e)));
    const failed = tops.filter((_, i) => !ok[i]).map((e) => e.name);
    notify(
      failed.length
        ? { title: `${space.name} is asleep, but some programs didn't stop`, body: failed.join(", "), level: "warning" }
        : { title: `${space.name} is asleep`, body: `${tops.length} program${tops.length === 1 ? "" : "s"} stopped. Wake it from the space menu.`, level: "success" },
    );
  }

  async wake(id) {
    const s = this.state.sleeping[id];
    if (!s) return;
    if (offline(id)) return notify({ title: `${s.name}'s machine is offline`, level: "warning" });
    if (s.items.some(missingCodexSession)) return notify({ title: `${s.name}: Codex needs a session ID`, body: CODEX_SESSION_HELP, level: "warning" });
    this.toWake.delete(id); // woken now: a later sleep isn't this launch's to wake
    const tops = s.items.filter((e) => !e.parent);
    const ok = await Promise.all(tops.map(start));
    const skipped = tops.filter((_, i) => !ok[i]);
    // What didn't start stays asleep for the next wake; sub-agents are never resumed.
    if (skipped.length) s.items = skipped;
    else delete this.state.sleeping[id];
    await this.save();
    this.publish();
    notify(
      skipped.length
        ? { title: `${s.name} is still partly asleep`, body: `Not restarted (busy or gone): ${skipped.map((e) => e.name).join(", ")}`, level: "warning" }
        : { title: `${s.name} is awake`, body: `${tops.length} program${tops.length === 1 ? "" : "s"} resumed.`, level: "success" },
    );
  }

  // Rolling snapshot, and loss detection: a recovered terminal keeps its address
  // but gets a new shell pid; a program exited on purpose leaves the same shell.
  async pass(_cx) {
    const ids = new Set(spaces().map((s) => s.id));
    let pruned = false;
    for (const id of Object.keys(this.state.sleeping)) if (!offline(id) && !ids.has(id)) delete this.state.sleeping[id], (pruned = true);
    if (pruned) await this.save(), this.publish();
    const live = (await Promise.all((await list()).filter((t) => local(t.address)).map((t) => get(t.address)))).filter(Boolean);
    const byAddress = new Map(live.map((g) => [g.address, g]));
    const next = {};
    for (const g of live) {
      if (g.parent || !g.labels?.["herdr.space"]) continue;
      const e = await describe(g);
      if (e && !missingCodexSession(e)) next[e.address] = { ...e, status: null };
    }
    const now = Date.now();
    const recovered = [];
    for (const o of Object.values(this.state.rolling.items ?? {})) {
      if (next[o.address] || missingCodexSession(o)) continue;
      const g = byAddress.get(o.address) ?? (await get(o.address));
      if (g?.state === "live") {
        if (g.pid !== o.shellPid && idleShell(g)) recovered.push({ ...o, shellPid: g.pid, at: now });
      } else if (g && !["exited", "killed"].includes(g.reason) && now - (o.lostAt ?? now) < LOST_GRACE) {
        next[o.address] = { ...o, lostAt: o.lostAt ?? now };
      }
    }
    let dirty = false;
    if (JSON.stringify(next) !== JSON.stringify(this.state.rolling.items)) {
      this.state.rolling = { at: now, items: next };
      dirty = true;
    }
    if (recovered.length) {
      const known = new Set(this.state.pending.map((p) => p.address));
      this.state.pending.push(...recovered.filter((p) => !known.has(p.address)));
      dirty = true;
    }
    if (dirty) await this.save();
    await this.offer();
  }

  // Pending items still waiting in the same idle shell they were found in.
  async stillPending() {
    const out = [];
    for (const p of this.state.pending) {
      const g = await get(p.address);
      if (g && g.pid === p.shellPid && idleShell(g)) out.push(p);
    }
    if (out.length !== this.state.pending.length) {
      this.state.pending = out;
      await this.save();
    }
    return out;
  }

  async offer() {
    if (!this.state.pending.length) return;
    if (this.settings.after_restart === "off") {
      this.state.pending = [];
      return this.save();
    }
    const items = await this.stillPending();
    const key = items.map((p) => `${p.address}:${p.shellPid}`).sort().join(",");
    if (items.some(missingCodexSession)) {
      if (!this.offered.has(key)) notify({ title: "Codex needs a session ID", body: CODEX_SESSION_HELP, level: "warning" });
      this.offered.add(key);
      return;
    }
    if (this.settings.after_restart === "auto") {
      if (items.length) await this.resume(items, true);
      return;
    }
    if (!items.length || this.offered.has(key)) return;
    this.offered.add(key);
    // One dialog at a time; the replaced one's answer is ignored as stale.
    if (this.state.offer?.id) closeOverlay(this.state.offer.id);
    const names = new Map(spaces().map((s) => [s.id, s.name]));
    const nonce = Date.now();
    const id = openOverlay({
      mod: "hibernate",
      kind: "dialog",
      modal: true,
      width: 560,
      height: Math.min(620, 214 + 60 * items.length),
      props: { view: "resume", offer: nonce, items: items.map((p) => ({ address: p.address, name: p.name, where: names.get(p.space) ?? p.cwd, line: commandLine(p) })) },
    });
    this.state.offer = { nonce, id };
    await this.save();
  }

  async answer(a) {
    if (a.dialog && (a.offer == null || a.offer !== this.state.offer?.nonce)) return;
    if (!a.dialog && this.state.offer?.id) closeOverlay(this.state.offer.id);
    this.state.offer = null;
    const chosen = new Set(a.resume ?? []);
    const items = (await this.stillPending()).filter((p) => chosen.has(p.address));
    if (items.some(missingCodexSession)) return notify({ title: "Codex needs a session ID", body: CODEX_SESSION_HELP, level: "warning" });
    this.state.pending = [];
    await this.save();
    if (items.length) await this.resume(items, false);
    // The dialog's "Resume automatically next time" is the after_restart setting.
    if (a.auto === true && this.settings.after_restart !== "auto") await this.setSetting("after_restart", "auto").catch((e) => console.log(`hibernate: ${e}`));
  }

  async resume(items, auto) {
    const ok = await Promise.all(items.map(start));
    this.state.pending = this.state.pending.filter((p) => !items.some((i) => i.address === p.address));
    await this.save();
    const n = ok.filter(Boolean).length;
    notify({ title: auto ? "Resumed after restart" : "Resumed", body: `${n} of ${items.length} program${items.length === 1 ? "" : "s"} started again.`, level: n === items.length ? "success" : "warning" });
  }

  render(cx) {
    if (this.view === "sleep") return SleepDialog.render(this, cx);
    if (this.view === "resume") return ResumeDialog.render(this, cx);
    return div().id("hibernate").size_full();
  }
}
