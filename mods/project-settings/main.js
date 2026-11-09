// Project settings, after Orca's: identity (name, icon), worktree defaults and what a new
// worktree starts with. Kept in shared "projects.settings", keyed by
// JSON.stringify([machine, main checkout folder]); better-sidebar and new-worktree read it.
// Opened as a dialog with props { space } (my-menu's "Project settings…").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, closeOverlay, spaces, panes, agents, exec, home, shared, setShared, knownAgents, pickFolder, run, notify, readTextFile } from "herdr";
import { teamScript, HOOK_VARS } from "./hooks.js";

export const KEY = "projects.settings";
export const projectKey = (machine, main) => JSON.stringify([machine ?? null, main]);
const GROUPS = "better-sidebar.groups";
const COLORS = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const ICONS = [["auto", "Automatic"], ["emoji", "Emoji"], ["letter", "Letter"]];
// new-worktree's built-in prompts (keep in step with its DEFAULTS).
const PROMPTS = {
  issue_prompt: 'Work on GitHub issue #{number} in {repo}: "{title}". Read it first with: gh issue view {number} -R {repo} --comments',
  pr_prompt: 'Pick up GitHub pull request #{number} in {repo}: "{title}". Read it first with: gh pr view {number} -R {repo} --comments',
};
const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p ?? "");
const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

export default class ProjectSettings extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props()?.space);
    this.machine = this.space?.machine ?? null;
    this.project = undefined; // { main, name, gh } | null when not in git
    this.agents = [];
    const field = (placeholder) => { const s = InputState.new({ placeholder }); s.on("change", (_e, cx) => cx.notify()); return s; };
    this.f = {
      name: field("Follows the folder name"), emoji: field("🚀"), base: field("The repo's default branch"),
      location: field("~/.herdr/worktrees/<project>"), issue_branch: field("dev/feat/{number}"),
    };
    // The setup script: several lines, run as one shell script.
    this.f.setup = TextareaState.new({ placeholder: "pnpm i\nln -s $HERDR_ROOT_PATH/.env $HERDR_WORKTREE_PATH/.env" });
    this.f.setup.set_auto_grow(4, 12);
    this.f.setup.on("change", (_e, cx) => cx.notify());
    // What new-worktree pastes into Claude for an issue or PR; the placeholder is its built-in wording.
    for (const [k, text] of Object.entries(PROMPTS)) {
      this.f[k] = TextareaState.new({ placeholder: text });
      this.f[k].set_auto_grow(3, 10);
      this.f[k].on("change", (_e, cx) => cx.notify());
    }
    this.when = "run"; this.wait = false; this.yamlSetup = null;
    this.icon = "auto"; this.color = "ansi6"; this.agent = ""; this.saved = false;
    this.members = null; // the spaces of this project, found after it's read
    this.confirming = false;
    cx.spawn(async (cx) => {
      const folder = this.space && place(this.space);
      const top = folder && (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on: this.machine }).catch(() => null));
      if (top?.code !== 0) { this.project = null; return cx.notify(); }
      const common = top.stdout.trim(), main = common.replace(/\/\.git\/?$/, "");
      const url = (await exec("git", ["remote", "get-url", "origin"], { cwd: main, on: this.machine }).catch(() => null))?.stdout?.trim() ?? "";
      const gh = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
      this.project = { main, common, name: main.split("/").pop(), gh };
      const s = (shared(KEY) ?? {})[projectKey(this.machine, main)] ?? {};
      for (const k of Object.keys(this.f)) this.f[k].set_value(k === "emoji" ? s.icon?.emoji ?? "" : k === "location" ? tilde(s[k] ?? "") : s[k] ?? "");
      this.icon = s.icon?.kind ?? "auto"; this.color = s.icon?.color ?? "ansi6"; this.agent = s.agent ?? "";
      this.when = s.setupWhen ?? "run"; this.wait = Boolean(s.setupWait);
      cx.notify();
      // The team's script from the repo: herdr.yaml, else orca.yaml.
      this.team = await teamScript((path) => readTextFile(path, { on: this.machine }), main);
      this.yamlSetup = this.team?.script ?? null;
      cx.notify();
      // Every space on this machine whose checkout belongs to the project: its main one and its worktrees.
      const members = [];
      for (const sp of spaces().filter((x) => (x.machine ?? null) === this.machine)) {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: place(sp), on: this.machine }).catch(() => null);
        if (r?.code === 0 && r.stdout.trim() === common) members.push(sp);
      }
      this.members = members;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents({ on: this.machine }).catch(() => [])).filter((a) => a.installed);
      cx.notify();
    });
  }

  close() { closeOverlay(props()?.overlay); }

  // Blank fields are left out: the mods then do what they did before.
  save() {
    const v = (k) => this.f[k].value().trim();
    const next = {
      ...(v("name") ? { name: v("name") } : {}),
      ...(this.icon !== "auto" ? { icon: { kind: this.icon, emoji: v("emoji"), color: this.color } } : {}),
      ...(v("base") ? { base: v("base") } : {}),
      ...(v("location") ? { location: expand(v("location")).replace(/\/+$/, "") } : {}),
      ...(v("issue_branch") ? { issue_branch: v("issue_branch") } : {}),
      ...(v("setup") ? { setup: v("setup") } : {}),
      ...(v("issue_prompt") ? { issue_prompt: v("issue_prompt") } : {}),
      ...(v("pr_prompt") ? { pr_prompt: v("pr_prompt") } : {}),
      ...(this.when !== "run" ? { setupWhen: this.when } : {}),
      ...(this.wait ? { setupWait: true } : {}),
      ...(this.agent ? { agent: this.agent } : {}),
    };
    const all = { ...(shared(KEY) ?? {}) }, key = projectKey(this.machine, this.project.main);
    if (Object.keys(next).length) all[key] = next; else delete all[key];
    setShared(KEY, all);
    this.close();
  }

  // Removes the project from Herdr: closes its spaces and forgets its settings and group.
  // Files, worktrees and branches stay on disk.
  remove() {
    const key = projectKey(this.machine, this.project.main), groupKey = JSON.stringify([this.machine ?? null, this.project.common]);
    for (const sp of this.members ?? []) run("space.close", { id: sp.id, confirmed: true });
    const all = { ...(shared(KEY) ?? {}) };
    delete all[key];
    setShared(KEY, all);
    const g = shared(GROUPS);
    if (g?.projects?.[groupKey]) {
      const projects = { ...g.projects };
      delete projects[groupKey];
      setShared(GROUPS, { ...g, projects });
    }
    notify({ title: `Removed ${this.f.name.value().trim() || this.project.name}`, body: "Its files and worktrees are still on disk.", timeout: 4000 });
    this.close();
  }

  // ---- drawing ----

  section(t, title) { return div().pt(18).pb(6).text_size(11.5).font_semibold().text_color(t.dim).child(title); }

  row(t, label, hint, control) {
    return h_flex().py(10).gap(16).items_center().border_b(1).border_color(t.border)
      .child(v_flex().w(190).flex_none().gap(2).child(div().text_size(13).text_color(t.foreground).child(label))
        .when(Boolean(hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(hint))))
      .child(div().flex_1().min_w(0).child(control));
  }

  input(t, id, state, width) {
    return div().id(id).h(32).px(10).when(Boolean(width), (el) => el.w(width)).flex().items_center().rounded(7).border_1()
      .border_color(t.input).bg(t.background).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w_full().h_full().text_size(13).text_color(t.foreground));
  }

  pills(t, id, options, value, pick) {
    return h_flex().gap(4).flex_wrap().children(options.map(([v, label]) => div().id(`${id}-${v}`).h(28).px(10).flex().items_center()
      .rounded(7).text_size(12.5).cursor_pointer().border_1().border_color(v === value ? t.accent : t.border)
      .bg(v === value ? t.selected : t.background).text_color(v === value ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(v); cx.notify(); }).child(label)));
  }

  button(t, id, text, onClick, solid = false) {
    return h_flex().id(id).h(34).px(14).flex_none().items_center().rounded(8).text_size(13).font_medium().border_1().cursor_pointer()
      .bg(solid ? t.foreground : t.raised).border_color(solid ? t.foreground : t.border).text_color(solid ? t.background : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(text);
  }

  // How the sidebar will draw it with these choices.
  preview(t) {
    const name = this.f.name.value().trim() || this.project.name, emoji = this.f.emoji.value().trim();
    const tile = (child, bg) => div().size(28).flex_none().rounded(7).flex().items_center().justify_center().bg(bg).child(child);
    const icon = this.icon === "emoji" && emoji ? tile(div().text_size(16).child(emoji), COLORS[this.color] + "33")
      : this.icon === "letter" ? tile(div().text_size(13).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?"), COLORS[this.color])
      : tile(div().text_size(11).text_color(t.dim).child("auto"), t.raised);
    return h_flex().gap(10).items_center().child(icon).child(v_flex().child(div().text_size(14).font_semibold().child(name))
      .child(div().text_size(11.5).text_color(t.dim).child(this.project.gh ?? tilde(this.project.main))));
  }

  // Worktree Hooks, after Orca's: the setup script, when it runs, and whether the agent waits.
  hooks(t) {
    const card = () => v_flex().mt(8).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.background);
    const toggle = (on, flip) => div().id("ps-wait").w(36).h(20).flex_none().rounded(10).p(2).cursor_pointer().flex()
      .bg(on ? t.accent : t.hover).when(on, (el) => el.justify_end()).on_click((_e, cx) => { flip(); cx.notify(); })
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
    const hasScript = Boolean(this.f.setup.value().trim() || this.yamlSetup);
    return v_flex()
      .child(this.section(t, "WORKTREE HOOKS"))
      .child(div().text_size(12).text_color(t.dim).child("Scripts that run when a worktree is created. Local scripts are stored on this machine; herdr.yaml scripts (or Orca's orca.yaml) are shared with your team."))
      .child(card()
        .child(v_flex().gap(3).child(div().text_size(14).font_semibold().child("Setup script"))
          .child(div().text_size(12.5).text_color(t.muted).child("Runs after a new worktree is created: install deps, copy env files, run migrations.")))
        .child(div().text_size(11.5).text_color(t.dim).child("Available environment variables (hover for details):"))
        .child(h_flex().gap(6).flex_wrap().children(HOOK_VARS.map(([name, about]) => div().id(`ps-var-${name}`).px(8).py(3).rounded(6)
          .border_1().border_color(t.border).bg(t.raised).text_size(11.5).font_family("JetBrains Mono").text_color(t.muted).tooltip(about).child(`$${name}`))))
        .when(Boolean(this.yamlSetup), (el) => el.child(v_flex().gap(4)
          .child(div().text_size(11.5).text_color(t.dim).child(`From ${this.team?.file ?? "herdr.yaml"} (shared with your team), runs first:`))
          .child(div().p(10).rounded(8).bg(t.raised).text_size(12).font_family("JetBrains Mono").text_color(t.muted).child(this.yamlSetup))))
        .child(div().id("ps-setup").p(10).rounded(8).border_1().border_color(t.input).bg(t.popover).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.f.setup).w_full().text_size(12.5).font_family("JetBrains Mono").text_color(t.foreground)))
        .child(div().text_size(11.5).text_color(t.dim).child("Runs as a single shell script. Saved on this machine. Orca's ORCA_* names work too.")))
      .child(card().opacity(hasScript ? 1 : 0.55)
        .child(h_flex().gap(12).items_center()
          .child(v_flex().flex_1().gap(3).child(div().text_size(14).font_semibold().child("When to run"))
            .child(div().text_size(12.5).text_color(t.muted).child("Default when a new worktree is created.")))
          .child(this.pills(t, "ps-when", [["ask", "Ask every time"], ["run", "Run by default"], ["skip", "Skip by default"]], this.when, (v) => { this.when = v; })))
        .child(div().h(1).bg(t.border))
        .child(h_flex().gap(12).items_center()
          .child(v_flex().flex_1().gap(3).child(div().text_size(13.5).child("Wait for setup to complete before starting agent"))
            .child(div().text_size(12).text_color(t.dim).child(this.wait ? "Setup runs first, then the agent, in one terminal." : "The agent starts at once; setup runs in a split below it.")))
          .child(toggle(this.wait, () => { this.wait = !this.wait; }))));
  }

  // The Claude prompts: full-width boxes, like the setup script, so a long prompt is readable.
  prompts(t) {
    const box = (k, title, about) => v_flex().gap(6)
      .child(v_flex().gap(3).child(div().text_size(14).font_semibold().child(title))
        .child(div().text_size(12.5).text_color(t.muted).child(about)))
      .child(div().id(`ps-${k}`).p(10).rounded(8).border_1().border_color(t.input).bg(t.popover).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.f[k]).w_full().text_size(12.5).text_color(t.foreground)));
    return v_flex().mt(8).p(14).gap(12).rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(box("issue_prompt", "Claude prompt for an issue", "Pasted into Claude (not sent) when a worktree starts from an issue."))
      .child(box("pr_prompt", "Claude prompt for a pull request", "Pasted into Claude (not sent) when a worktree starts from a PR."))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(div().text_size(11.5).text_color(t.dim).child("Filled in:"))
        .children(["{number}", "{title}", "{repo}", "{branch}"].map((p) => div().px(8).py(3).rounded(6).border_1().border_color(t.border)
          .bg(t.raised).text_size(11.5).font_family("JetBrains Mono").text_color(t.muted).child(p))))
      .child(div().text_size(11.5).text_color(t.dim).child("Blank uses Create worktree's Mod setting, else the wording shown."));
  }

  removal(t) {
    const members = this.members, busy = new Set(agents().filter((a) => a.status === "working" || a.status === "blocked").map((a) => a.space));
    const live = (members ?? []).filter((sp) => busy.has(sp.id));
    const danger = (id, text, onClick, filled) => h_flex().id(id).h(34).px(14).flex_none().items_center().rounded(8).text_size(13).font_medium()
      .border_1().border_color(t.blocked).bg(filled ? t.blocked : t.background).text_color(filled ? "#ffffff" : t.blocked).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(text);
    return v_flex()
      .child(this.section(t, "REMOVE"))
      .child(this.row(t, "Remove project", "Takes it out of Herdr. Files, worktrees and branches stay on disk.",
        h_flex().justify_end().child(this.confirming ? div()
          : danger("ps-remove", "Remove project…", (cx) => { this.confirming = true; cx.notify(); }, false))))
      .when(this.confirming, (el) => el.child(v_flex().mt(10).p(12).gap(10).rounded(9).border_1().border_color(t.blocked + "88").bg(t.blocked + "14")
        .child(div().text_size(13).text_color(t.foreground).child(members === null ? "Finding this project's spaces…"
          : members.length ? `Closes ${members.length} space${members.length === 1 ? "" : "s"}: ${members.map((sp) => sp.name).join(", ")}.`
          : "No spaces are open for it; its settings and group are forgotten."))
        .when(live.length > 0, (e) => e.child(div().text_size(12.5).text_color(t.blocked)
          .child(`Agents are still working in ${live.map((sp) => sp.name).join(", ")}: closing stops them.`)))
        .child(h_flex().gap(8).justify_end()
          .child(this.button(t, "ps-remove-cancel", "Keep it", (cx) => { this.confirming = false; cx.notify(); }))
          .when(members !== null, (e) => e.child(danger("ps-remove-confirm", "Remove project", () => this.remove(), true))))));
  }

  render() {
    const t = theme(), p = this.project;
    const body = p === undefined ? div().text_color(t.muted).child("Reading the project…")
      : p === null ? div().text_color(t.muted).child("This space isn't in a Git repository, so it has no project settings.")
      : v_flex()
        .child(this.preview(t))
        .child(this.section(t, "IDENTITY"))
        .child(this.row(t, "Display name", "Shown in the sidebar", this.input(t, "ps-name", this.f.name)))
        .child(this.row(t, "Project icon", "Automatic: picked image, GitHub avatar or repo logo", v_flex().gap(8)
          .child(this.pills(t, "ps-icon", ICONS, this.icon, (v) => { this.icon = v; }))
          .when(this.icon === "emoji", (el) => el.child(this.input(t, "ps-emoji", this.f.emoji, 90)))
          .when(this.icon !== "auto", (el) => el.child(h_flex().gap(6).children(Object.entries(COLORS).map(([k, hex]) =>
            div().id(`ps-color-${k}`).size(22).rounded(11).cursor_pointer().bg(hex).border_2().border_color(k === this.color ? t.foreground : t.popover)
              .on_click((_e, cx) => { this.color = k; cx.notify(); })))))))
        .child(this.section(t, "WORKTREES"))
        .child(this.row(t, "Default worktree base", "New branches start from it", this.input(t, "ps-base", this.f.base)))
        .child(this.row(t, "Worktree location", "Folder new worktrees go in", h_flex().gap(8)
          .child(div().flex_1().min_w(0).child(this.input(t, "ps-location", this.f.location)))
          .child(this.button(t, "ps-pick", "Choose…", (cx) => cx.spawn(async (cx) => {
            const dir = await pickFolder({ prompt: "Where this project's worktrees go" }).catch(() => null);
            if (dir) this.f.location.set_value(tilde(dir));
            cx.notify();
          })))))
        .child(this.row(t, "Issue branch name", "{number} and {slug} are filled in", this.input(t, "ps-issue", this.f.issue_branch)))
        .child(this.hooks(t))
        .child(this.section(t, "NEW WORKTREES START WITH"))
        .child(this.row(t, "Default agent", "Started in each new worktree", this.pills(t, "ps-agent",
          [["", "Last used"], ...this.agents.map((a) => [a.name, a.name])], this.agent, (v) => { this.agent = v; })))
        .child(this.prompts(t))
        .child(this.removal(t));
    return v_flex().id("project-settings").size_full().bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().h(52).flex_none().px(20).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(16).font_semibold().child("Project settings"))
        .child(div().text_size(11.5).text_color(t.dim).child("Esc")))
      .child(div().id("ps-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(16).child(body))
      .child(h_flex().h(60).flex_none().px(20).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Leave a field blank to keep the current behaviour."))
        .child(this.button(t, "ps-cancel", "Cancel", () => this.close()))
        .when(Boolean(p), (el) => el.child(this.button(t, "ps-save", "Save", () => this.save(), true))));
  }
}
