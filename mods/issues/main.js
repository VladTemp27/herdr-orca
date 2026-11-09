import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, openOverlay, closeOverlay, props, shared, setShared } from "herdr";
import { spaceFor, startWorkspace } from "./start.js";
import { Viewer, openUrl, labelChip } from "./viewer.js";
import { icons, icon, avatarPath, loadAvatar } from "./icons.js";
import { readCache, writeCache, age, repoChanged } from "./cache.js";
import { Projects, filterMenuView } from "./projects.js";

// Orca-style issues and PRs table, opened as a popup (mod.json overlay).
// Popups it opens (filters, repo, row menus) answer through shared "issues.pick".

const DEFAULT = { issues: "is:issue is:open", prs: "is:pr is:open", projects: "" };
const FIELDS = {
  issues: "number,title,author,state,stateReason,labels,assignees,updatedAt,url",
  prs: "number,title,author,state,isDraft,labels,assignees,updatedAt,url,headRefName",
};
const PAGE = 25;
const LIMIT = 200;
const SYNC = 60000;
// Lists are cached on disk per repo, tab and query. Within FRESH nothing is asked; after it, a
// conditional request (free when unchanged) decides; past MAX_AGE the list is fetched anyway.
const FRESH = 60000;
const MAX_AGE = 15 * 60000;
const MISS_TTL = 6 * 3600000;
const GITHUB = { open: "#3fb950", done: "#a371f7", skipped: "#8b949e" };

// Where the focused pane is, as the Changes panel finds it.
function location(last) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && last) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

function remembered(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; }
}

// Repo memory lives in Herdr's shared state: each popup copy has its own localStorage, so
// what one copy learned (or picked) was lost to the next. Old localStorage entries merge in.
const REPOS_TTL = 30 * 60 * 1000;
const sharedMap = (key, legacy) => ({ ...remembered(legacy), ...(shared(`issues.${key}`) ?? {}) });
const remember = (key, id, value) => setShared(`issues.${key}`, { ...(shared(`issues.${key}`) ?? {}), [id]: value });

// "41 minutes ago", "yesterday", as the screenshot reads.
function updated(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) { const m = Math.round(s / 60); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return m < 12 ? `${m} month${m === 1 ? "" : "s"} ago` : `${Math.floor(m / 12)}y ago`;
}

const pick = (value) => setShared("issues.pick", { ...value, at: Date.now() });

export default class Issues extends View {
  init(_props, cx) {
    const { issue, overlay, copyMenu: copying, menu, repoMenu, filterMenu } = props() ?? {};
    if (filterMenu) { this.filterMenu = { ...filterMenu, overlay }; return; }
    if (issue) { this.viewer = new Viewer(issue, overlay, cx); return; }
    if (copying) { this.copying = { ...copying, overlay }; return; }
    if (menu) { this.menu = { ...menu, overlay }; return; }
    if (repoMenu) return this.initRepoMenu(repoMenu, overlay);

    this.overlay = overlay;
    this.repos = sharedMap("folders", "repos"); this.logins = sharedMap("logins", "logins"); this.spaceRepos = sharedMap("spaces", "spaces");
    this.tab = shared("issues.tab") ?? "issues"; this.query = { ...DEFAULT }; this.page = 0;
    this.projects = new Projects(this);
    this.results = {}; this.loading = null; this.error = null;
    this.pickAt = shared("issues.pick")?.at; this.changedAt = shared("issues.changed")?.at;
    this.input = InputState.new({ placeholder: "Search", value: this.query[this.tab] });
    this.input.on("submit", (_e, cx) => this.apply(this.input.value(), cx));
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
    this.resolve(cx);
    this.refreshRepos(cx);
    this.scanLocal(cx);
    cx.timer.every(SYNC, (cx) => this.load(cx));
  }

  // Every repo the gh login can see (owned, collaborator, organisations), cached for 30 minutes.
  refreshRepos(cx) {
    if (Date.now() - (shared("issues.allRepos")?.at ?? 0) < REPOS_TTL) return;
    cx.spawn(async () => {
      const r = await exec("gh", ["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
        "-q", '.[] | [.full_name, (.private | tostring)] | @tsv']).catch(() => null);
      if (r?.code !== 0) return;
      const list = r.stdout.split("\n").filter(Boolean).map((l) => { const [repo, priv] = l.split("\t"); return { repo, private: priv === "true" }; });
      if (list.length) setShared("issues.allRepos", { at: Date.now(), list });
    });
  }

  // The repos checked out here: every local terminal's folder, so the picker can list them first.
  scanLocal(cx) {
    const tried = new Set(Object.keys(this.repos).map((k) => JSON.parse(k)[0]));
    const local = new Set(spaces().filter((s) => !s.machine).map((s) => s.id));
    const folders = [...new Set(panes().filter((p) => p.cwd && local.has(spaces().find((s) => s.tabs.some((c) => c.id === p.tab))?.id)).map((p) => p.cwd))];
    cx.spawn(async () => { for (const cwd of folders) if (!tried.has(cwd)) await this.repoFor(cwd, null); });
  }

  // ---- data ----

  async repoFor(cwd, on) {
    const id = JSON.stringify([cwd, on]);
    if (!this.repos[id] && Date.now() - (shared("issues.misses")?.[id] ?? 0) > MISS_TTL) {
      const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd, on }).catch(() => null);
      if (r?.code === 0) { this.repos[id] = r.stdout.trim(); remember("folders", id, this.repos[id]); }
      // Only a definite "not a GitHub repo" is remembered; an offline failure is asked again.
      else if (/not a git repository|no git remotes|none of the git remotes/i.test(r?.stderr ?? "")) remember("misses", id, Date.now());
    }
    return this.repos[id] ?? null;
  }

  // The repo picked last (remembered across popups and restarts); else, when following,
  // the focused terminal's repo, else the one this space last had.
  resolve(cx) {
    const { cwd, on } = (this.last = location(this.last)), space = focused()?.space;
    cx.spawn(async (cx) => {
      const found = cwd ? await this.repoFor(cwd, on) : null;
      if (found) { this.spaceRepos[space] = { repo: found, on }; remember("spaces", space, this.spaceRepos[space]); }
      const selected = shared("issues.selected");
      this.following = !selected?.repo;
      this.detected = found ?? this.spaceRepos[space]?.repo ?? null;
      const choice = selected?.repo ? selected : found ? { repo: found, on } : this.spaceRepos[space];
      this.repo = choice?.repo ?? null; this.repoOn = choice?.on ?? null; this.resolved = true;
      if (this.repo) {
        const id = this.repoOn ?? "";
        if (!this.logins[id]) {
          const r = await exec("gh", ["api", "user", "-q", ".login"], { on: this.repoOn }).catch(() => null);
          if (r?.code === 0) { this.logins[id] = r.stdout.trim(); remember("logins", id, this.logins[id]); }
        }
        this.me = this.logins[id];
      }
      cx.notify();
      this.load(cx);
    });
  }

  key() { return `${this.repo}|${this.tab}|${this.query[this.tab]}`; }

  // The list for the query: the disk cache at once, then GitHub only when it may have changed.
  // force (Refresh, the person's own edits) always fetches.
  load(cx, force = false) {
    if (!this.repo) return;
    if (this.tab === "projects") return this.projects.load(cx, force);
    const key = this.key(), held = this.results[key];
    if (!force && age(held) < FRESH) return;
    // A load older than 45s (exec gives up at 30s) never blocks a new one.
    if (this.loading?.key === key && Date.now() - this.loading.at < 45000) return;
    const loading = (this.loading = { key, at: Date.now() });
    this.error = null;
    const kind = this.tab === "prs" ? "pr" : "issue", q = this.query[this.tab], tab = this.tab, repo = this.repo, on = this.repoOn;
    const store = (entry) => { this.results[key] = entry; writeCache(`list:${key}`, entry); };
    cx.spawn(async (cx) => {
      cx.notify();
      try {
        let entry = held ?? (await readCache(`list:${key}`));
        if (entry && !held) { this.results[key] = entry; cx.notify(); }
        if (!force && age(entry) < FRESH) return;
        const probe = await repoChanged(repo, on, !force && age(entry) < MAX_AGE ? entry?.etag : null);
        if (!probe.changed) return store({ ...entry, at: Date.now() });
        const r = await exec("gh", [kind, "list", "-R", repo, "--state", "all", "--search", q, "--limit", String(LIMIT), "--json", FIELDS[tab]], { on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        const items = JSON.parse(r.stdout);
        if (!/\bsort:/.test(q)) items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        store({ at: Date.now(), etag: probe.etag, items });
      } catch (e) { if (this.key() === key) this.error = String(e?.message ?? e); }
      finally { if (this.loading === loading) this.loading = null; cx.notify(); }
    });
  }

  apply(q, cx) {
    this.query[this.tab] = q.trim() || DEFAULT[this.tab];
    if (this.tab === "projects") setShared("issues.projectQuery", this.query.projects);
    this.input.set_value(this.query[this.tab]);
    this.page = 0; this.load(cx); cx.notify();
  }

  setTab(tab, cx) {
    this.tab = tab; this.page = 0; setShared("issues.tab", tab); this.input.set_value(this.query[tab]); this.load(cx); cx.notify();
  }

  // A popup's answer (shared "issues.pick").
  handle(p, cx) {
    if (p.query !== undefined) return this.apply(p.query, cx);
    if (p.project || p.groupBy || p.toggleField || p.setField || p.fieldMenu || p.projectsRefresh || p.toggleFilter || p.clearFilter) return this.projects.handle(p, cx);
    if (p.follow) { setShared("issues.selected", null); this.page = 0; return this.resolve(cx); }
    if (p.repo) {
      setShared("issues.selected", { repo: p.repo, on: p.on ?? null });
      setShared("issues.recent", [p.repo, ...(shared("issues.recent") ?? []).filter((r) => r !== p.repo)].slice(0, 6));
      this.following = false;
      this.repo = p.repo; this.repoOn = p.on ?? null; this.page = 0;
      const id = this.repoOn ?? "";
      if (this.logins[id]) this.me = this.logins[id];
      else cx.spawn(async (cx) => {
        const r = await exec("gh", ["api", "user", "-q", ".login"], { on: this.repoOn }).catch(() => null);
        if (r?.code === 0) { this.me = this.logins[id] = r.stdout.trim(); remember("logins", id, this.me); cx.notify(); }
      });
      return this.load(cx);
    }
    if (p.gh) cx.spawn(async (cx) => {
      const r = await exec("gh", p.gh, { on: this.repoOn }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.error = (r.stderr || r.stdout).trim();
      this.load(cx, true);
    });
  }

  // ---- actions ----

  kind() { return this.tab === "prs" ? "pr" : "issue"; }

  spaceFor(i) { return spaceFor(i, this.tab === "prs"); }

  // A local folder of the repo, for git worktree; null when none is known (a repo picked
  // from GitHub that isn't checked out here), rather than some other repo's folder.
  folder(repo = this.repo) {
    const hit = Object.entries(this.repos).find(([k, v]) => v === repo && (JSON.parse(k)[1] ?? null) === (this.repoOn ?? null));
    return hit ? JSON.parse(hit[0])[0] : null;
  }

  // Start: the Create worktree dialog with this issue or PR picked; Open when its space exists.
  // repo/pr: a Projects item can be from another repo than the picked one.
  start(i, cx, { repo = this.repo, pr = this.tab === "prs" } = {}) {
    const folder = this.folder(repo);
    if (!folder) { (this.tab === "projects" ? this.projects : this).error = `No checkout of ${repo} is known here. Open a terminal in one, then Start.`; return cx.notify(); }
    const args = { repo, machine: this.repoOn, folder, item: i, pr, overlay: this.overlay };
    cx.spawn(async () => startWorkspace(args));
  }

  openIssue(i, { repo = this.repo, pr = this.tab === "prs" } = {}) {
    openOverlay({ mod: "issues", kind: "dialog", width: 0.86, height: 0.9, props: { issue: {
      repo, number: i.number, on: this.repoOn, data: null, me: this.me,
      pr, folder: this.folder(repo), machine: this.repoOn } } });
  }

  // Under the control just pressed: Herdr's default spot (the pointer) isn't tracked over
  // this dialog, so popups landed where the pointer last was in the window (the sidebar).
  anchor() {
    const b = this.press?.bounds, p = this.press?.position;
    this.press = null;
    return b ? { x: b.x, y: b.y + b.height + 4 } : p ? { x: p.x, y: p.y } : null;
  }

  // at: a spot kept from an earlier press, for a menu opened from another menu.
  popup(menu, width = 240, at = this.anchor()) {
    openOverlay({ mod: "issues", kind: "popup", width, ...(at ? { at } : {}), height: Math.min(460, 14 + (menu.title ? 26 : 0) + menu.items.reduce((h, it) => h + (it.hint ? 46 : 34), 0)), props: { menu } });
  }

  // ---- drawing helpers ----

  glyph(name, size, color) {
    return div().size(size).flex_none().when(this.icons, (e) => e.child(svg(icon(name)).size(size).when(Boolean(color), (s) => s.text_color(color))));
  }

  btn(id, t, child, onClick, { solid = false, square = false, h = 34 } = {}) {
    return h_flex().id(id).h(h).when(square, (e) => e.w(h).justify_center()).when(!square, (e) => e.px(12)).gap(6).flex_none().items_center()
      .rounded(8).border_1().border_color(solid ? t.foreground : t.border).bg(solid ? t.foreground : t.background)
      .text_color(solid ? t.background : t.foreground).text_size(13).cursor_pointer()
      .hover((s) => s.bg(solid ? t.foreground : t.hover)).on_mouse_down("left", (e, cx) => { this.press = e; cx.stop_propagation(); })
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).children(Array.isArray(child) ? child : [child]);
  }

  chip(id, label, on, t, onClick) {
    return div().id(id).h(32).px(14).flex().items_center().rounded(8).text_size(13).cursor_pointer()
      .bg(on ? t.foreground : t.raised).text_color(on ? t.background : t.foreground).when(on, (e) => e.font_medium())
      .hover((s) => s.bg(on ? t.foreground : t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  avatar(login, size, t, cx) {
    const loading = loadAvatar(login, null);
    if (loading) cx.spawn(async (cx) => { if (await loading) cx.notify(); });
    const path = avatarPath(login);
    return path ? image(path).size(size).flex_none().rounded(size / 2)
      : div().size(size).flex_none().rounded(size / 2).bg(t.raised).flex().items_center().justify_center().text_size(10).text_color(t.muted)
        .child(login.slice(0, 1).toUpperCase());
  }

  updated(iso) { return updated(iso); }

  status(i, t, pr = this.tab === "prs") {
    const [label, color, glyph] = pr
      ? (i.state === "MERGED" ? ["Merged", GITHUB.done, "pull"] : i.state === "CLOSED" ? ["Closed", GITHUB.skipped, "pull"] : i.isDraft ? ["Draft", GITHUB.skipped, "pull"] : ["Open", GITHUB.open, "pull"])
      : (i.state === "OPEN" ? ["Open", GITHUB.open, "issue"] : i.stateReason === "NOT_PLANNED" ? ["Closed", GITHUB.skipped, "skipped"] : ["Closed", GITHUB.done, "done"]);
    return { label, color, glyph };
  }

  // ---- render ----

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    const t = theme();
    if (this.copying) return this.copyMenuView(t);
    if (this.menu) return this.menuView(t);
    if (this.filterMenu) return filterMenuView(this, t);
    if (this.repoMenu) return this.repoMenuView(t);
    const p = shared("issues.pick");
    // Handled just after this render: cx.notify() throws during render, which left loads stuck.
    if (p?.at && p.at !== this.pickAt) { this.pickAt = p.at; cx.timer.after(0, (cx) => this.handle(p, cx)); }
    const changed = shared("issues.changed");
    if (changed?.at && changed.at !== this.changedAt) { this.changedAt = changed.at; cx.timer.after(0, (cx) => this.load(cx, true)); }

    return v_flex().id("issues").size_full().min_h(0).rounded(12).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).px(20).pt(14).pb(16).gap(12)
      .child(this.topBar(t))
      .child(this.tabsRow(t))
      .child(!this.repo ? this.empty(t) : this.tab === "projects" ? this.projects.card(t, cx) : this.card(t, cx));
  }

  topBar(t) {
    const where = ["GitHub", this.repoOn ?? "This Mac", this.repo].filter(Boolean).join(" · ");
    return h_flex().h(36).gap(10).items_center()
      .child(div().id("issues-close").size(32).flex().items_center().justify_center().rounded(8).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(this.overlay)).child(this.glyph("close", 18)))
      .child(div().size(34).flex().items_center().justify_center().rounded(8).border_1().border_color(t.border).bg(t.raised).child(this.glyph("github", 17)))
      .child(div().h(30).px(12).flex().items_center().rounded(8).border_1().border_color(t.border).text_size(13).text_color(t.muted).child(where));
  }

  tabsRow(t) {
    const known = [...new Map([...Object.entries(this.repos).map(([k, v]) => [v, JSON.parse(k)[1] ?? null]),
      ...Object.values(this.spaceRepos).map((s) => [s.repo, s.on ?? null])]).entries()].sort(([a], [b]) => a.localeCompare(b));
    return h_flex().gap(8).items_center()
      .child(this.chip("tab-issues", "Issues", this.tab === "issues", t, (cx) => this.setTab("issues", cx)))
      .child(this.chip("tab-prs", "PRs", this.tab === "prs", t, (cx) => this.setTab("prs", cx)))
      .child(this.chip("tab-projects", "Projects", this.tab === "projects", t, (cx) => this.setTab("projects", cx)))
      .child(this.btn("repo-pick", t, [div().size(8).rounded(2).bg(t.muted), div().child(this.repo?.split("/")[1] ?? "Choose repository"), this.glyph("updown", 14, t.muted)],
        () => {
          const at = this.anchor();
          openOverlay({ mod: "issues", kind: "popup", width: 420, height: 480, ...(at ? { at } : {}),
            props: { repoMenu: { current: this.repo, following: this.following, detected: this.detected ?? null, local: known } } });
        }))
      .when(Boolean(this.repo), (e) => e
        .child(this.btn("repo-github", t, this.glyph("external", 16), () => openUrl(`https://github.com/${this.repo}/${{ prs: "pulls", projects: "projects" }[this.tab] ?? "issues"}`), { square: true })));
  }

  empty(t) {
    return v_flex().flex_1().items_center().justify_center().gap(10).rounded(12).border_1().border_color(t.border)
      .child(this.glyph("issue", 28, t.dim))
      .child(div().font_semibold().text_color(t.muted).child(this.resolved ? "No repository yet" : "Looking for a repository…"))
      .child(div().text_size(12).text_color(t.dim).child("Focus a terminal inside a GitHub repository and its issues show up here."));
  }

  card(t, cx) {
    const q = this.query[this.tab], base = DEFAULT[this.tab], mine = `${base} assignee:@me`;
    const items = this.results[this.key()]?.items ?? [], pages = Math.max(1, Math.ceil(items.length / PAGE));
    if (this.page >= pages) this.page = pages - 1;
    const shown = items.slice(this.page * PAGE, (this.page + 1) * PAGE);
    return v_flex().flex_1().min_h(0).rounded(12).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(h_flex().px(18).pt(14).gap(8)
        .child(this.chip("seg-open", "Open", q === base, t, (cx) => this.apply(base, cx)))
        .child(this.chip("seg-mine", "Assigned to me", q === mine, t, (cx) => this.apply(mine, cx))))
      .child(h_flex().px(18).py(12).gap(8).items_center()
        .child(this.btn("filters", t, [this.glyph("filter", 16), div().child("Filters")], () => this.filters()))
        .child(this.searchBox(t, q, base))
        .child(this.btn("new", t, this.glyph("plus", 16), () => openUrl(`https://github.com/${this.repo}/${this.tab === "prs" ? "compare" : "issues/new"}`), { square: true }))
        .child(this.btn("refresh", t, this.loading ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.working).spin(900) : this.glyph("refresh", 16),
          (cx) => this.load(cx, true), { square: true })))
      .when(Boolean(this.error), (e) => e.child(div().px(18).pb(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(this.row(null, t, cx))
      .child(v_flex().id(`rows-${this.key()}-${this.page}`).flex_1().min_h(0).overflow_y_scrollbar()
        .children(shown.map((i) => this.row(i, t, cx)))
        .when(!shown.length, (e) => e.child(div().py(40).text_center().text_size(12).text_color(t.dim)
          .child(this.loading ? "Loading…" : this.tab === "prs" ? "No pull requests match" : "No issues match"))))
      .when(pages > 1, (e) => e.child(this.pager(pages, t)));
  }

  searchBox(t, q, base) {
    return h_flex().id("search").flex_1().min_w(0).h(34).px(12).gap(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.glyph("search", 16, t.muted))
      .child(div().flex_1().min_w(0).child(Input.new(this.input).h_full().text_size(13).text_color(t.foreground)))
      .when(q !== base, (e) => e.child(div().id("search-clear").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.apply(base, cx)).child(this.glyph("close", 16))));
  }

  // One table row; null draws the column headings.
  row(i, t, cx) {
    const head = !i;
    const cell = (w, child) => h_flex().w(w).flex_none().items_center().child(child);
    const label = (s) => div().text_size(11).font_semibold().text_color(t.dim).child(s);
    const r = h_flex().px(18).gap(12).items_center().border_b(1).border_color(t.border);
    if (head) return r.h(40).bg(t.chrome)
      .child(cell(96, label("ID"))).child(div().flex_1().child(label("TITLE / CONTEXT")))
      .child(cell(120, label("ASSIGNEES"))).child(cell(120, label("STATUS"))).child(cell(130, label("UPDATED"))).child(cell(130, div()));

    const s = this.status(i, t), space = this.spaceFor(i), repoName = this.repo.split("/")[1];
    const assignees = i.assignees ?? [];
    const stop = (e, cx) => { this.press = e; cx.stop_propagation(); };
    const kind = this.kind(), n = String(i.number);
    return r.id(`row-${i.number}`).min_h(72).py(10).bg(t.background).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click(() => this.openIssue(i))
      .child(cell(96, h_flex().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
        .child(this.glyph(s.glyph, 13, t.muted)).child(`#${i.number}`)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().text_size(14).truncate().child(i.title))
        .child(h_flex().gap(10).items_center().text_size(12).text_color(t.muted).overflow_hidden()
          .child(div().flex_none().child(i.author?.login?.replace(/^app\//, "") ?? "ghost"))
          .child(div().flex_none().child(repoName))
          .children((i.labels ?? []).slice(0, 4).map((l) => labelChip(l, t)))))
      .child(cell(120, assignees.length || this.me
        ? h_flex().id(`assign-${n}`).h(30).px(5).gap(4).items_center().rounded(15).hover((st) => st.bg(t.raised)).on_mouse_down("left", stop)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            const mine = assignees.some((a) => a.login === this.me);
            this.popup({ title: "Assignees", items: [
              ...assignees.map((a) => ({ label: a.login, check: true })),
              mine ? { label: "Unassign me", pick: { gh: [kind, "edit", n, "-R", this.repo, "--remove-assignee", "@me"] } }
                : { label: "Assign yourself", pick: { gh: [kind, "edit", n, "-R", this.repo, "--add-assignee", "@me"] } },
            ] });
          })
          .when(!assignees.length, (e) => e.child(div().px(4).text_color(t.dim).child("–")))
          .children(assignees.slice(0, 3).map((a) => this.avatar(a.login, 22, t, cx)))
          .when(assignees.length > 0, (e) => e.child(this.glyph("chevron", 12, t.muted)))
        : div().text_color(t.dim).child("–")))
      .child(cell(120, h_flex().id(`status-${n}`).h(26).px(8).gap(5).items_center().rounded(13).border_1().border_color(s.color + "99").bg(s.color + "1a")
        .text_size(12).text_color(s.color).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const open = i.state === "OPEN", reopen = { label: "Reopen", pick: { gh: [kind, "reopen", n, "-R", this.repo] } };
          this.popup({ title: "Status", items: kind === "pr"
            ? (open ? [{ label: "Close pull request", pick: { gh: ["pr", "close", n, "-R", this.repo] } }] : i.state === "CLOSED" ? [reopen] : [{ label: "Merged", check: true }])
            : open ? [
              { label: "Close as completed", hint: "Done, fixed, resolved", pick: { gh: ["issue", "close", n, "-R", this.repo, "--reason", "completed"] } },
              { label: "Close as not planned", hint: "Won't fix, duplicate, stale", pick: { gh: ["issue", "close", n, "-R", this.repo, "--reason", "not planned"] } },
            ] : [reopen] });
        })
        .child(this.glyph(s.glyph, 12, s.color)).child(s.label).child(this.glyph("chevron", 11, s.color))))
      .child(cell(130, div().text_size(12).text_color(t.muted).child(updated(i.updatedAt))))
      .child(cell(130, h_flex().gap(6).items_center().justify_end()
        .child(this.btn(`start-${n}`, t, [div().font_medium().child(space ? "Open" : "Start"), this.glyph("arrow", 14)], (cx) => this.start(i, cx), { solid: Boolean(space), h: 30 }))
        .child(div().id(`more-${n}`).size(28).flex().items_center().justify_center().rounded(6).text_color(t.muted)
          .hover((st) => st.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.popup({ items: [
              { label: "Copy link", hint: i.url, copy: i.url },
              { label: "Copy reference", hint: `${this.repo}#${n}`, copy: `${this.repo}#${n}` },
              { label: "Copy number and title", hint: `#${n} ${i.title}`, copy: `#${n} ${i.title}` },
              { label: "Open on GitHub", open: i.url },
            ] }, 300);
          })
          .child(this.glyph("dots", 16)))));
  }

  pager(pages, t) {
    const at = this.page, from = Math.max(0, Math.min(at - 2, pages - 5)), nums = Array.from({ length: Math.min(5, pages) }, (_, k) => from + k);
    const nav = (id, label, go, on) => h_flex().id(id).h(34).px(12).gap(4).items_center().rounded(8).text_size(14)
      .text_color(on ? t.foreground : t.dim).when(on, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.page = go; cx.notify(); }))
      .children(label);
    return h_flex().h(60).flex_none().gap(6).items_center().justify_center().border_t(1).border_color(t.border)
      .child(nav("prev", [this.glyph("left", 14), div().child("Previous")], at - 1, at > 0))
      .children(nums.map((k) => div().id(`page-${k}`).size(34).flex().items_center().justify_center().rounded(8).text_size(14).cursor_pointer()
        .bg(k === at ? t.foreground : t.chrome).text_color(k === at ? t.background : t.muted).hover((s) => s.bg(k === at ? t.foreground : t.hover))
        .on_click((_e, cx) => { this.page = k; cx.notify(); }).child(String(k + 1))))
      .child(nav("next", [div().child("Next"), this.glyph("right", 14)], at + 1, at < pages - 1));
  }

  // Filters: GitHub search qualifiers written into the query.
  filters() {
    const base = DEFAULT[this.tab], q = this.query[this.tab];
    const toggle = (token) => (q.includes(token) ? q.replace(token, "").replace(/\s+/g, " ").trim() : `${q} ${token}`);
    const state = (s) => `${q.replace(/\bis:(open|closed|merged)\b/g, "").replace(/\s+/g, " ").trim()} ${s}`.trim();
    const sort = (s) => `${q.replace(/\bsort:\S+/g, "").replace(/\s+/g, " ").trim()} sort:${s}`;
    this.popup({ title: "Filters", items: [
      { label: "Open", check: /\bis:open\b/.test(q), pick: { query: state("is:open") } },
      { label: "Closed", check: /\bis:closed\b/.test(q), pick: { query: state("is:closed") } },
      ...(this.tab === "prs" ? [{ label: "Merged", check: /\bis:merged\b/.test(q), pick: { query: state("is:merged") } }] : []),
      { label: "Assigned to me", check: q.includes("assignee:@me"), pick: { query: toggle("assignee:@me") } },
      { label: "Created by me", check: q.includes("author:@me"), pick: { query: toggle("author:@me") } },
      { label: "No assignee", check: q.includes("no:assignee"), pick: { query: toggle("no:assignee") } },
      { label: "Recently updated", check: /sort:updated-desc/.test(q) || !/sort:/.test(q), pick: { query: sort("updated-desc") } },
      { label: "Newest", check: /sort:created-desc/.test(q), pick: { query: sort("created-desc") } },
      { label: "Most commented", check: /sort:comments-desc/.test(q), pick: { query: sort("comments-desc") } },
      { label: "Reset", hint: base, pick: { query: base } },
    ] }, 260);
  }

  // ---- popups ----

  // The repo picker: a filter, then Follow focused terminal, Recent, On this machine, All.
  initRepoMenu(m, overlay) {
    this.repoMenu = { ...m, overlay };
    this.filter = InputState.new({ placeholder: "Search repositories" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.filter.on("submit", () => { const first = this.repoRows().find((r) => r.repo); if (first) this.choose(first); });
    this.filter.focus();
  }

  repoRows() {
    const { current, following, detected, local = [] } = this.repoMenu, q = this.filter.value().trim().toLowerCase();
    const all = shared("issues.allRepos")?.list ?? [], recent = shared("issues.recent") ?? [];
    const priv = new Map(all.map((r) => [r.repo, r.private])), seen = new Set(), rows = [];
    const hit = (repo) => !q || repo.toLowerCase().includes(q);
    const section = (title, items) => {
      const fresh = items.filter(([repo]) => repo && hit(repo) && !seen.has(repo));
      if (!fresh.length) return;
      rows.push({ heading: title });
      for (const [repo, on] of fresh) { seen.add(repo); rows.push({ repo, on, hint: on ?? (priv.get(repo) ? "private" : ""), check: !following && repo === current }); }
    };
    if (!q) rows.push({ follow: true, label: "Follow focused terminal", hint: detected ?? "No repo in the focused terminal", check: following });
    section("RECENT", recent.map((r) => [r, local.find(([x]) => x === r)?.[1] ?? null]));
    section("ON THIS MACHINE", local);
    section("ALL REPOSITORIES", all.map((r) => [r.repo, null]));
    return rows.slice(0, 250);
  }

  choose(row) {
    pick(row.follow ? { follow: true } : { repo: row.repo, on: row.on ?? null });
    closeOverlay(this.repoMenu.overlay);
  }

  repoMenuView(t) {
    const rows = this.repoRows(), loading = !shared("issues.allRepos");
    return v_flex().id("repo-menu").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.glyph("search", 15, t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.filter).h_full().text_size(13).text_color(t.foreground))))
      // A popup is only as tall as its content, so the list has a height of its own.
      .child(v_flex().id("repo-list").h(436).flex_none().overflow_y_scrollbar().p(6).gap(1)
        .children(rows.map((r, k) => r.heading
          ? div().px(8).pt(8).pb(3).text_size(11).font_semibold().text_color(t.dim).child(r.heading)
          : h_flex().id(`repo-${k}`).min_h(34).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click(() => this.choose(r))
            .child(div().w(14).flex_none().text_color(t.accent).child(r.check ? "✓" : ""))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().child(r.follow ? r.label : r.repo))
              .when(Boolean(r.follow), (e) => e.child(div().truncate().text_size(11).text_color(t.muted).child(r.hint))))
            .when(!r.follow && Boolean(r.hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(r.hint)))))
        .when(loading, (e) => e.child(div().px(8).py(8).text_size(12).text_color(t.dim).child("Loading your repositories…")))
        .when(!loading && rows.every((r) => !r.repo), (e) => e.child(div().px(8).py(8).text_size(12).text_color(t.dim).child("No repositories match"))));
  }

  menuView(t) {
    const { title, items, overlay } = this.menu;
    return v_flex().id("issues-menu").size_full().overflow_y_scrollbar().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(13)
      .when(Boolean(title), (e) => e.child(div().px(8).pt(4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(title)))
      .children(items.map((it, k) => it.heading ? div().px(8).pt(8).pb(3).text_size(11).font_semibold().text_color(t.dim).child(it.heading) : h_flex().id(`m-${k}`).min_h(32).px(8).gap(8).items_center().rounded(6)
        .when(Boolean(it.pick || it.copy || it.open), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          if (it.copy) cx.write_to_clipboard(it.copy);
          else if (it.open) openUrl(it.open);
          else if (it.pick) pick(it.pick);
          else return;
          closeOverlay(overlay);
        })
        .child(div().w(14).flex_none().text_color(t.accent).child(it.check ? "✓" : ""))
        .child(v_flex().flex_1().min_w(0).child(div().truncate().child(it.label))
          .when(Boolean(it.hint), (e) => e.child(div().text_size(11).text_color(t.muted).truncate().child(it.hint))))));
  }

  copyMenuView(t) {
    const { url, ref, number, title, overlay } = this.copying;
    const items = [["Copy link", url], ["Copy reference", ref], ["Copy number", number], ["Copy number and title", title]].filter(([, text]) => text);
    return v_flex().id("issues-copy").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
      .children(items.map(([label, text], n) => v_flex().id(`copy-${n}`).px(8).py(6).rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(text); closeOverlay(overlay); })
        .child(div().font_semibold().child(label))
        .child(div().text_size(11).text_color(t.muted).truncate().child(text))));
  }
}
