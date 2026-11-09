// Create worktree: pick a source (a branch, an issue, a PR, or nothing), then edit the
// branch and space names it prefills. Opens an existing checkout instead of making a second.
// Props: { space?, folder?, machine?, mode?, pick?: { kind: "issue" | "pr", number, title?, head? }, task? }.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, appHome, knownAgents, readTextFile, notify, window, shared } from "herdr";
import { ROOT, slug, titleSlug, tilde, git, place, repoOf, branches, openPRs, openIssues, prFor, badBranch, parseRef, lookup } from "./git.js";
import { teamScript, hookEnv } from "./hooks.js";

const MODES = [
  { id: "branch", label: "Branch", icon: "git-branch", hint: "Filter branches, including ones only on origin" },
  { id: "issue", label: "Issue", icon: "issue", hint: "Filter open issues, or paste #123 or a link" },
  { id: "pr", label: "PR", icon: "pull-request", hint: "Filter open pull requests, or paste #123 or a link" },
  { id: "new", label: "New", icon: "plus", hint: "" },
];
const DEFAULTS = { issue_branch: "dev/feat/{number}" };
const icon = (name, size = 14) => svg(`mods/new-worktree/icons/${name}.svg`).size(size).flex_none();
const stop = (_e, cx) => cx.stop_propagation();

export default class NewWorktree extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
    this.on = p.machine !== undefined ? p.machine : (this.space?.machine ?? null);
    this.mode = MODES.some((m) => m.id === p.mode) ? p.mode : localStorage.getItem("mode") ?? "branch";
    if (!MODES.some((m) => m.id === this.mode)) this.mode = "branch";
    this.text = "";
    this.at = 0;
    this.pick = null; // the source the Details fields were filled from
    this.menu = null; // "project" | "base" | "agent"
    this.projects = [];
    this.project = undefined; // undefined: looking, null: not in git
    this.data = null;
    this.github = null; // { prs, issues } once read
    this.settings = DEFAULTS;
    this.agents = [];
    this.agent = localStorage.getItem("agent");
    this.handle = cx.focus_handle();
    this.search = this.field_(cx, "", MODES.find((m) => m.id === this.mode).hint, (v, cx) => this.typed(v, cx));
    this.branch = this.field_(cx, "", "branch name", () => {});
    this.name = this.field_(cx, "", "Follows the folder name", () => {});
    (this.mode === "new" ? this.branch : this.search).focus();
    cx.spawn(async (cx) => this.load(p.folder, cx));
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents({ on: this.on }).catch(() => [])).filter((a) => a.installed);
      if (this.agent == null) this.agent = this.agents.find((a) => /claude/i.test(a.name))?.name ?? "";
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${appHome()}/mods/new-worktree/mod.json`);
        this.settings = { ...DEFAULTS, ...(JSON.parse(raw ?? "{}").settings ?? {}) };
        cx.notify();
      } catch { /* defaults */ }
    });
  }

  field_(cx, value, placeholder, onChange) {
    const state = InputState.new({ value, placeholder });
    state.on("change", (_e, cx) => { this.error = ""; onChange(state.value(), cx); cx.notify(); });
    state.on("submit", (_e, cx) => this.go(cx));
    return state;
  }

  async load(folder, cx) {
    this.home = this.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }).catch(() => null))?.stdout?.trim() : home();
    const start = await repoOf(folder || place(this.space), this.on);
    // Every repo among this machine's spaces, the current one first.
    const seen = new Map(start ? [[start.main, start]] : []);
    for (const s of spaces().filter((s) => (s.machine ?? null) === this.on)) {
      const r = await repoOf(place(s), this.on);
      if (r && !seen.has(r.main)) seen.set(r.main, r);
    }
    this.projects = [...seen.values()];
    await this.choose(start ?? this.projects[0] ?? null, cx);
  }

  // The project's own settings (project-settings mod); blank fields keep the defaults.
  own() {
    return this.project ? (shared("projects.settings") ?? {})[JSON.stringify([this.on ?? null, this.project.main])] ?? {} : {};
  }

  // Where a new worktree for this branch goes: the project's location, else ~/.herdr/worktrees/<repo>.
  dirFor(branch) {
    const at = this.own().location;
    return at ? `${at}/${slug(branch)}` : `${ROOT(this.home ?? "")}/${this.project.name}/${slug(branch)}`;
  }

  async choose(project, cx) {
    this.project = project;
    this.data = null;
    this.github = null;
    this.menu = null;
    this.setPick(null);
    cx.notify();
    if (!project) return;
    this.data = await branches(project, this.on);
    if (this.project !== project) return;
    this.base = this.own().base || this.data.base;
    if (this.own().agent) this.agent = this.own().agent;
    // The team's script (herdr.yaml, else orca.yaml) runs before this machine's own.
    const yaml = (await teamScript((path) => readTextFile(path, { on: this.on }), project.main))?.script ?? null;
    if (this.project !== project) return;
    this.setupScript = [yaml, this.own().setup].filter(Boolean).join("\n") || null;
    // Run by default, skip by default, or ask (no answer yet: Create waits for one).
    const when = this.own().setupWhen ?? "run";
    this.runSetup = when === "ask" ? null : when === "run";
    if (this.mode === "new") this.setPick({ kind: "new" });
    cx.notify();
    if (project.gh) {
      const [prs, issues] = await Promise.all([openPRs(project.gh).catch(() => []), openIssues(project.gh).catch(() => [])]);
      if (this.project !== project) return;
      this.github = { prs, issues };
      // Issues → Start: open on that issue or PR, already picked.
      const want = props()?.pick;
      if (want && !this.pick) {
        this.mode = want.kind === "pr" ? "pr" : "issue";
        this.search.set_value(`#${want.number}`);
        this.text = `#${want.number}`;
        this.select(this.items()[0] ?? null, cx);
      }
      cx.notify();
    }
  }

  // New remote branches appear only after a fetch; this never changes a checkout.
  fetch(cx) {
    const project = this.project;
    if (!project || this.fetching) return;
    this.fetching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await git(project.main, ["fetch", "--prune", "origin"], this.on);
      if (!r.ok) this.error = r.err || "git fetch failed.";
      this.fetching = false;
      if (this.project === project) await this.choose(project, cx);
    });
  }

  close() { closeOverlay(props().overlay); }

  // ── Sources ──────────────────────────────────────────────────────────────

  // A pasted #N or link on the Branch or New tab jumps to its Issue or PR tab.
  typed(value, cx) {
    this.text = value;
    this.at = 0;
    const ref = parseRef(value.trim());
    if (ref && (this.mode === "branch" || this.mode === "new") && (ref.kind || value.trim().startsWith("#"))) {
      if (ref.kind) return this.setMode(ref.kind, cx, value);
      const gh = this.github, number = ref.number;
      if (gh?.prs.some((p) => p.number === number)) return this.setMode("pr", cx, value);
      if (gh?.issues.some((i) => i.number === number)) return this.setMode("issue", cx, value);
    }
    if (this.mode !== "new") this.select(this.items()[0] ?? null, cx);
  }

  items() {
    const d = this.data, m = this.mode;
    if (!d || m === "new") return [];
    const q = this.text.trim(), ql = q.toLowerCase();
    const has = (s) => !ql || s.toLowerCase().includes(ql);
    const gh = this.github ?? { prs: [], issues: [] };
    const ref = parseRef(q);
    if (m === "branch") {
      const out = [], used = new Set(d.worktrees.map((w) => w.branch));
      for (const w of d.worktrees) if (!w.main && w.branch && has(w.branch))
        out.push({ kind: "open", branch: w.branch, path: w.path, label: w.branch, sub: tilde(w.path, this.home), tag: "Open", icon: "folder", mono: true });
      for (const b of d.local) if (!used.has(b.name) && has(b.name))
        out.push({ kind: "local", branch: b.name, label: b.name, sub: "Local branch", tag: "Local", icon: "git-branch", mono: true });
      for (const b of d.remote) if (has(b.name))
        out.push({ kind: "remote", branch: b.name, label: b.name, sub: `origin/${b.name} · not checked out here`, tag: "Remote", icon: "cloud", mono: true });
      return out.slice(0, 80);
    }
    const list = m === "pr" ? gh.prs : gh.issues;
    const item = (x) => (m === "pr" ? this.prItem(x) : this.issueItem(x));
    if (ref) {
      const hit = list.find((x) => x.number === ref.number);
      return [hit ? item(hit) : { kind: "lookup", want: m, number: ref.number, label: `#${ref.number}`, sub: "Not in the open list · look it up on GitHub", tag: "GitHub", icon: "github" }];
    }
    return list.filter((x) => has(x.title) || has(`#${x.number}`) || (x.headRefName && has(x.headRefName))).map(item);
  }

  prItem(p) {
    return { kind: "pr", number: p.number, head: p.headRefName, title: p.title, label: p.title, sub: `#${p.number} · ${p.headRefName}`, tag: "PR", icon: "pull-request" };
  }

  issueItem(i) {
    const pr = prFor(this.github?.prs ?? [], i.number, this.template(i));
    return { kind: "issue", number: i.number, title: i.title, pr, label: i.title, sub: `#${i.number}${pr ? ` · PR #${pr.number} works on it` : ""}`, tag: "Issue", icon: "issue" };
  }

  template(i) {
    return String(this.own().issue_branch || this.settings.issue_branch || DEFAULTS.issue_branch)
      .replaceAll("{number}", String(i.number)).replaceAll("{slug}", titleSlug(i.title ?? ""));
  }

  // Fills the Details fields from a source; they stay editable.
  setPick(item) {
    this.pick = item;
    if (!item) return;
    const branch = item.kind === "pr" ? item.head : item.kind === "issue" ? (item.pr?.headRefName ?? this.template(item)) : item.branch ?? "";
    const name = item.kind === "pr" || item.kind === "issue" ? item.title : "";
    this.branch.set_value(branch);
    this.name.set_value(name);
  }

  select(item, cx) {
    if (item?.kind === "lookup") return this.resolve(item, cx);
    this.setPick(item);
  }

  // #N that isn't in the open lists: ask GitHub what it is.
  resolve(item, cx) {
    this.pick = item;
    if (!this.project?.gh || item.looking) return;
    item.looking = true;
    cx.spawn(async (cx) => {
      try {
        const it = await lookup(this.project.gh, item.number);
        if (this.pick !== item) return;
        // Kept in the list so its row shows what it is from now on.
        const found = it.kind === "pr" ? { number: it.number, title: it.title, headRefName: it.head } : { number: it.number, title: it.title };
        if (this.github) this.github[it.kind === "pr" ? "prs" : "issues"].unshift(found);
        this.mode = it.kind === "pr" ? "pr" : "issue";
        this.setPick(it.kind === "pr" ? this.prItem(found) : this.issueItem(found));
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  setMode(mode, cx, text = "") {
    this.mode = mode;
    localStorage.setItem("mode", mode);
    this.at = 0;
    this.menu = null;
    this.text = text;
    this.search.set_value(text);
    if (mode === "new") { this.setPick({ kind: "new" }); this.branch.focus(); }
    else { this.setPick(null); this.select(this.items()[0] ?? null, cx); this.search.focus(); }
    cx.notify();
  }

  // ── What Create would do, from the Branch field as it is now ─────────────

  plan() {
    const d = this.data, branch = this.branch.value().trim(), pick = this.pick;
    if (!d || !pick || pick.kind === "lookup") return null;
    if (badBranch(branch)) return { error: branch ? `"${branch}" isn't a valid branch name.` : "Name the branch." };
    const open = d.worktrees.find((w) => w.branch === branch);
    if (open) return { action: "open", path: open.path, note: `Already checked out at ${tilde(open.path, this.home)} · opens it` };
    if (d.local.some((b) => b.name === branch)) return { action: "local", note: pick.kind === "issue" ? `${branch} already exists · checks it out` : "Local branch · checks it out" };
    if (d.allRemote.some((b) => b.name === branch)) return { action: "remote", note: `Only on origin · makes a local branch tracking origin/${branch}` };
    if (pick.kind === "pr" && branch === pick.head) return { action: "remote", fetch: true, note: `Fetches ${branch} from origin, then tracks it` };
    // A new branch: from the picked branch or PR when renamed, else from the base.
    const from = pick.kind === "local" || pick.kind === "open" ? pick.branch : pick.kind === "remote" ? `origin/${pick.branch}`
      : pick.kind === "pr" ? `origin/${pick.head}` : null;
    const folder = tilde(this.dirFor(branch), this.home);
    return { action: "new", from: from ?? this.base, fromBase: !from, fetchFrom: pick.kind === "pr" ? pick.head : null,
      note: `New branch from ${from ?? this.base} · ${folder}` };
  }

  // ── Making or opening the checkout ───────────────────────────────────────

  go(cx) {
    // One create per dialog: a held ⌘↵ or the field's own submit can arrive after the
    // first finished, before the dialog closed and before Herdr lists the new space.
    if (this.done) return;
    const plan = this.plan();
    if (!plan || plan.error || this.busy) return;
    if (this.setupScript && this.runSetup == null) { this.error = "Choose whether to run the setup script."; return cx.notify(); }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.create(plan, cx);
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  async create(plan, cx) {
    const r = this.project, on = this.on, pick = this.pick, branch = this.branch.value().trim();
    const g = async (args) => {
      const res = await git(r.main, args, on);
      if (!res.ok) throw Error(res.err || `git ${args[0]} failed.`);
      return res;
    };
    const fetch = (b) => g(["fetch", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`]);
    const path = plan.action === "open" ? plan.path : this.dirFor(branch);
    if (plan.action === "local") await g(["worktree", "add", path, branch]);
    if (plan.action === "remote") {
      if (plan.fetch) await fetch(branch);
      await g(["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]);
    }
    if (plan.action === "new") {
      await g(["check-ref-format", "--branch", branch]);
      if (plan.fetchFrom && !this.data.allRemote.some((b) => b.name === plan.fetchFrom)) await fetch(plan.fetchFrom);
      // Not tracking the start point, so the first push makes its own remote branch.
      await g(["worktree", "add", "--no-track", "-b", branch, path, plan.from]);
    }
    // The sidebar reads these to show the issue and PR on the worktree.
    const link = (key, n) => r.gh && git(r.main, ["config", `branch.${branch}.${key}`, `${r.gh}#${n}`], on);
    if (pick.kind === "issue") { await link("herdr-issue", pick.number); if (pick.pr && branch === pick.pr.headRefName) await link("herdr-pr", pick.pr.number); }
    if (pick.kind === "pr" && branch === pick.head) await link("herdr-pr", pick.number);
    await this.open(path, cx);
  }

  // An open space on the checkout is selected (and renamed if a name was typed);
  // otherwise a new one starts there, with the agent and, for an issue or PR, its task.
  async open(path, cx) {
    if (this.done) return;
    this.done = true;
    localStorage.setItem("agent", this.agent ?? "");
    const name = this.name.value().trim();
    const inside = (cwd) => cwd === path || cwd?.startsWith(path + "/");
    const s = spaces().find((s) => (s.machine ?? null) === this.on && inside(place(s)));
    if (s) {
      run("space.select", { id: s.id });
      if (name && name !== s.name) run("space.rename", { id: s.id, name });
      return;
    }
    const agent = this.agents.find((a) => a.name === this.agent);
    const task = this.task(agent);
    if (task) await this.prefill(task, cx);
    // The setup script (Worktree Hooks in project settings) runs in your login shell ($SHELL -lic),
    // so what your profile puts on PATH (pnpm, nvm, mise…) is there, with the HERDR_* variables.
    // Waiting: setup, then the agent, in one terminal. Not waiting: the agent starts; setup gets its own tab.
    const script = this.setupScript && this.runSetup ? this.setupScript : null;
    const where = { folder: path, ...(this.on ? { machine: this.on } : {}), ...(name ? { name } : {}) };
    if (!script) return run("space.new", { ...where, ...(agent ? { argv: agent.run } : {}) });
    const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
    const inShell = (body) => ["env", ...hookEnv(this.project.main, path), "sh", "-c", 'exec "${SHELL:-/bin/zsh}" -lic "$1"', "sh", body];
    // rc, not status: zsh's $status is read-only.
    const report = 'rc=$?\nif [ "$rc" -eq 0 ]; then echo "Setup finished."; else echo "Setup failed (exit $rc)."; fi';
    const shell = 'exec "${SHELL:-/bin/zsh}" -l';
    if (this.own().setupWait || !agent) {
      run("space.new", { ...where, argv: inShell(`${script}\n${report}\n${agent ? `exec ${agent.run.map(q).join(" ")}` : shell}`) });
      return;
    }
    run("space.new", { ...where, argv: agent.run });
    // The new space shows up a moment later: add a Setup tab, then go back to the agent's tab.
    for (let i = 0; i < 30; i++) {
      const sp = spaces().find((x) => (x.machine ?? null) === (this.on ?? null) && x.folder === path && x.tabs?.length);
      if (sp) {
        const agentTab = sp.tabs[0].id;
        run("tab.new", { space: sp.id, name: "Setup", argv: inShell(`${script}\n${report}\n${shell}`) });
        run("tab.select", { id: agentTab });
        return;
      }
      await cx.sleep(200);
    }
    notify({ title: "Setup script didn't start", body: "The new space didn't appear in time; run it there yourself.", level: "warning" });
  }

  task(agent) {
    const pick = this.pick, repo = this.project.gh;
    if (props()?.task) return props().task;
    if (!agent || agent.run?.[0] !== "claude" || !repo) return null;
    if (pick.kind === "issue") return `Work on GitHub issue #${pick.number} in ${repo}: "${pick.title}". Read it first with: gh issue view ${pick.number} -R ${repo} --comments`;
    if (pick.kind === "pr") return `Pick up GitHub pull request #${pick.number} in ${repo}: "${pick.title}". Read it first with: gh pr view ${pick.number} -R ${repo} --comments`;
    return null;
  }

  // The issues mod's helper pastes the task into Claude's prompt once it's ready, without sending it.
  // It watches this computer's terminals only and needs sh, so a remote space, or any space of a
  // Windows app, gets the task on the clipboard (the app's own, so it works where pbcopy doesn't).
  async prefill(task, cx) {
    const platform = window()?.platform;
    if (!this.on && platform !== "windows") {
      await exec("sh", ["-c", 'nohup sh "$0" "$@" >/dev/null 2>&1 &', `${appHome()}/mods/issues/prefill.sh`, task]).catch(() => null);
      return;
    }
    cx.write_to_clipboard(task);
    // Outside macOS terminal.paste is Ctrl+Shift+V; Ctrl+V on Linux goes to the program instead.
    notify({ title: "Task copied", body: `Paste it into the agent with ${platform === "macos" ? "⌘V" : "Ctrl+Shift+V"}.` });
  }

  key(e, cx) {
    const items = this.items(), n = items.length;
    if (e.key === "escape") { if (this.menu) { this.menu = null; cx.notify(); } else this.close(); return cx.stop_propagation(); }
    if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { cx.stop_propagation(); if (!e.is_held) this.go(cx); return; }
    if ((e.key === "down" || e.key === "up") && n) {
      this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      this.select(items[this.at], cx);
      cx.stop_propagation();
      cx.notify();
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  label(t, text, extra) {
    return h_flex().gap(4).items_center().text_size(11.5).font_medium().text_color(t.muted)
      .child(text).when(Boolean(extra), (el) => el.child(div().font_normal().text_color(t.dim).child(extra)));
  }

  // A select-like field; its options open below it.
  select_(t, id, leading, text, menu) {
    const open = this.menu === menu;
    return h_flex().id(id).h(34).px(10).gap(8).items_center().rounded(8).border_1()
      .border_color(open ? t.accent : t.border).bg(t.background).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.menu = open ? null : menu; cx.notify(); })
      .child(leading).child(div().flex_1().min_w(0).truncate().text_size(13).child(text))
      .child(icon("chevron-down", 13).text_color(t.dim));
  }

  options(t, id, rows) {
    return v_flex().id(id).max_h(200).overflow_y_scrollbar().p(5).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .children(rows.map(([key, lead, text, selected, pick]) => h_flex().id(`${id}-${key}`).h(31).flex_none().px(8).gap(9).items_center()
        .rounded(7).cursor_pointer().text_size(12.8).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); pick(cx); })
        .child(lead).child(div().flex_1().min_w(0).truncate().child(text))
        .when(selected, (el) => el.child(icon("check", 13)))));
  }

  input(t, state, { mono = false } = {}) {
    return h_flex().h(34).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(state).flex_1().h(30).text_size(mono ? 12.5 : 13).text_color(t.foreground)
        .when(mono, (el) => el.font_family("Geist Mono")));
  }

  agentIcon(a, t) {
    if (!a?.icon) return icon("terminal", 14).text_color(t.muted);
    return a.tint ? svg(a.icon).size(14).flex_none().text_color(t.foreground) : image(a.icon).size(14).flex_none();
  }

  row(t, item, i) {
    const on = i === this.at;
    const tone = { Remote: t.ansi4, Open: t.ansi2, PR: t.ansi2, Issue: t.ansi2 }[item.tag] ?? t.muted;
    return h_flex().id(`nw-item-${i}`).h(42).flex_none().px(10).gap(10).items_center().rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.at = i; this.select(item, cx); cx.notify(); })
      .child(icon(item.icon, 14).text_color(tone))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(item.mono ? 12.5 : 13).text_color(t.foreground).when(Boolean(item.mono), (el) => el.font_family("Geist Mono")).child(item.label))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(item.sub)))
      .child(div().flex_none().h(20).px(7).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(tone).child(item.tag));
  }

  details(t, plan, agent) {
    const pick = this.pick;
    const note = plan?.error ?? plan?.note ?? (pick?.kind === "lookup" ? "Looking it up on GitHub…" : "");
    const from = pick?.kind === "issue" && pick.pr && this.branch.value().trim() === pick.pr.headRefName ? `From PR #${pick.pr.number} · ` : "";
    return v_flex().gap(10).p(12).rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(div().text_size(11).font_medium().text_color(t.dim).child("Details"))
      .child(v_flex().gap(6)
        .child(this.label(t, "Branch"))
        .child(this.input(t, this.branch, { mono: true }))
        .when(Boolean(note), (el) => el.child(div().text_size(11.5).text_color(plan?.error ? t.blocked : t.dim).child(from + note))))
      .child(v_flex().gap(6)
        .child(this.label(t, "Space name"))
        .child(this.input(t, this.name)))
      .child(v_flex().gap(6)
        .child(this.label(t, "Agent", "[Optional]"))
        .child(this.select_(t, "nw-agent", this.agentIcon(agent, t), agent?.name ?? "None · just a terminal", "agent"))
        .when(this.menu === "agent", (el) => el.child(this.options(t, "nw-agents", [
          ["none", icon("terminal", 14).text_color(t.muted), "None · just a terminal", !agent, (cx) => { this.agent = ""; this.menu = null; cx.notify(); }],
          ...this.agents.map((a) => [a.name, this.agentIcon(a, t), a.name, a === agent, (cx) => { this.agent = a.name; this.menu = null; cx.notify(); }]),
        ]))))
      .when(Boolean(this.setupScript), (el) => el.child(v_flex().gap(6)
        .child(this.label(t, "Setup script", this.runSetup == null ? "[Choose]" : ""))
        .child(h_flex().gap(6).items_center()
          .children([[true, "Run"], [false, "Skip"]].map(([v, text]) => div().id(`nw-setup-${text}`).h(28).px(12).flex().items_center()
            .rounded(7).text_size(12.5).cursor_pointer().border_1().border_color(this.runSetup === v ? t.accent : t.border)
            .bg(this.runSetup === v ? t.selected : t.background).text_color(this.runSetup === v ? t.foreground : t.muted)
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { this.runSetup = v; this.error = ""; cx.notify(); }).child(text)))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).font_family("JetBrains Mono")
            .child(this.setupScript.split("\n").filter(Boolean).join(" · "))))));
  }

  render(cx) {
    const t = theme(), r = this.project, items = this.items(), mac = window()?.platform === "macos";
    const agent = this.agents.find((a) => a.name === this.agent);
    const plan = this.plan();
    const loading = r === undefined || (r && !this.data);
    const ready = Boolean(plan && !plan.error) && !this.busy;
    const showBase = plan?.action === "new" && plan.fromBase;
    const empty = loading ? "Reading branches…" : r === null ? "Open this from a space inside a git repository."
      : (this.mode === "issue" || this.mode === "pr") && !r.gh ? "This repo's origin isn't on GitHub."
      : (this.mode === "issue" || this.mode === "pr") && !this.github ? "Loading from GitHub…" : "Nothing matches.";
    return v_flex().id("new-worktree").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().px(22).pt(18).pb(18).gap(14).bg(t.popover).text_color(t.foreground).text_size(13)
      // Title
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Create worktree"))
        .child(div().id("nw-close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child(icon("close", 14))))
      // Project
      .child(v_flex().gap(6)
        .child(this.label(t, "Project"))
        .child(this.select_(t, "nw-project", icon("folder", 14).text_color(t.muted), r ? r.name : r === null ? "Not in a git repository" : "Finding repositories…", "project"))
        .when(this.menu === "project", (el) => el.child(this.options(t, "nw-projects", this.projects.map((p) =>
          [p.main, icon("folder", 14).text_color(t.muted), `${p.name}  ${tilde(p.main, this.home)}`, p === r, (cx) => cx.spawn(async (cx) => this.choose(p, cx))])))))
      // Source tabs, the base for a new branch, and fetch
      .child(h_flex().gap(4).items_center()
        .children(MODES.map((m) => h_flex().id(`nw-mode-${m.id}`).h(29).px(10).gap(7).items_center().rounded(7)
          .border_1().border_color(this.mode === m.id ? t.border : t.popover).bg(this.mode === m.id ? t.raised : t.popover)
          .text_size(12.8).text_color(this.mode === m.id ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.setMode(m.id, cx))
          .child(icon(m.icon, 13)).child(m.label)))
        .child(div().flex_1())
        .when(showBase, (el) => el
          .child(div().text_size(11).text_color(t.dim).child("Create from"))
          .child(h_flex().id("nw-base").h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.menu === "base" ? t.accent : t.border)
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { this.menu = this.menu === "base" ? null : "base"; cx.notify(); })
            .child(this.base ?? "…").child(icon("chevron-down", 11).text_color(t.dim))))
        .child(div().id("nw-fetch").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .tooltip("Fetch from origin").hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => this.fetch(cx))
          .child(this.fetching ? icon("refresh", 13).spin(900) : icon("refresh", 13))))
      .when(this.menu === "base" && showBase && Boolean(this.data), (el) => el.child(this.options(t, "nw-bases",
        [...new Set([this.data.base, ...this.data.allRemote.map((b) => `origin/${b.name}`), ...this.data.local.map((b) => b.name)])].map((b) =>
          [b, icon("git-branch", 13).text_color(t.muted), b, b === this.base, (cx) => { this.base = b; this.menu = null; cx.notify(); }]))))
      // Search and its matches (the New tab has none)
      .when(this.mode !== "new", (el) => el
        .child(h_flex().h(36).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
          .child(icon("search", 14).text_color(t.dim))
          .child(Input.new(this.search).flex_1().h(32).text_size(13).text_color(t.foreground)))
        .child(div().relative().flex_1().min_h(80)
          .child(v_flex().id(`nw-items-${this.mode}`).size_full().overflow_y_scroll().gap(1)
            .children(items.map((item, i) => this.row(t, item, i)))
            .when(!items.length, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(empty))))
          .child(Scrollbar.vertical(`nw-items-${this.mode}`).absolute().inset_0())))
      .when(this.mode === "new", (el) => el.child(div().flex_none()))
      // Details: what Create will make, editable
      .when(Boolean(this.pick), (el) => el.child(this.details(t, plan, agent)))
      .when(this.mode === "new", (el) => el.child(div().flex_1()))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      // Footer
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(this.mode === "new" ? "↵ create · esc close" : "↑↓ choose · ↵ create · esc close"))
        .child(h_flex().id("nw-create").h(34).px(14).gap(8).items_center().rounded(8).text_size(13).font_medium()
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
          .when(ready, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.go(cx)))
          .child(this.busy ? "Working…" : plan?.action === "open" ? "Open worktree" : "Create worktree")
          .child(div().text_size(11).opacity(0.7).child(mac ? "⌘↵" : "Ctrl↵"))));
  }
}
