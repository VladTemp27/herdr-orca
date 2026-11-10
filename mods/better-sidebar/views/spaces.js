// The spaces list: the branch and PR status under each name, nested worktrees.
// Repository facts follow each space's first terminal.
import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  machines,
  panes,
  run,
  openOverlay,
  closeOverlay,
  hc,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
  nextCommand,
  setAgentOrder,
  home,
  exec,
  focused,
} from "herdr";
import { PRStatusObserver, prPlaceKey, prAppearance } from "../git/pr-status.js";
import { spaceFolder, checkoutKey, readCheckout } from "../git/checkouts.js";
import { findRepoIcon, pickedIcon } from "../git/project-icons.js";
import { loadSettings, duration } from "../settings.js";
import { findNode } from "./find-node.js";
import { TEXT, Icon, IconButton, Badge } from "./ui.js";
import { HOVER_KEY, LIVE_KEY } from "./card.js";
import { noteOf, openNote } from "./notes.js";
import { SpaceAgents, inlineAgents, setInlineAgents } from "./space-agents.js";
import { ORDER_KEY } from "./space-nav.js";
import { readGroups, groupTint, isFolded, setFold, toggleFold, fileUnder, newGroupWith, openNameDialog, openProjectPicker, openGroupMenu } from "./groups.js";

const CARD_DELAY_MS = 450;
const CARD_CLOSE_MS = 250;

// A repo's working folder, from the [machine, git common dir] key.
const repoRoot = (g) => JSON.parse(g.repo)[1].replace(/\/\.git\/?$/, "");
// A project's own settings (project-settings mod): display name and icon, keyed by machine and main checkout.
const projectOf = (w, g) => (g?.repo ? (shared("projects.settings") ?? {})[JSON.stringify([w.machine ?? null, repoRoot(g)])] ?? null : null);
// The name a row shows: a space you named keeps it; a project's main checkout shows its display name.
const shownName = (w, g) => (!w.named && g && !g.linked && projectOf(w, g)?.name) || w.name;
const rowHeight = ({ tree }) => (tree ? 28 : 30);

// Watches and terminal events handle most changes. Poll visible repositories
// occasionally to catch edits and commits made outside Herdr.
const GIT_FALLBACK_MS = 15000;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = { git: { retry_after: "15s" }, pull_request_status: true };

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const AVATAR_COLORS = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

// A space speaks up only when something in it needs you.
function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

function tone(t, status) {
  return t[status] ?? t.unknown;
}

export class Spaces {
  // ── Lifecycle and refresh scheduling ──────────────────────────────────────

  init(_props, cx) {
    this.prObserver = new PRStatusObserver();
    this.settings = DEFAULT_SETTINGS;
    this.applySettings(cx);
    // Repository caches are keyed by [machine, folder], so equal paths on
    // different machines cannot share Git or PR state. null means not a repo.
    this.git = Object.create(null);
    this.checked = {}; // Checkout key -> last Git read time.
    this.unsure = new Set(); // Transient failures, eligible for retry.
    this.pending = new Set(); // Deduplicated queue for the single Git reader.

    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // Space ID -> checkout key at the previous refresh.
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.iconAt = {}; // repo key -> last icon lookup
    this.remoteHome = {}; // machine -> its home folder, for new spaces
    this.repoIcons = {};
    try {
      this.repoIcons = JSON.parse(localStorage.getItem("repo.icons") ?? "{}");
    } catch {
      /* Ignore invalid saved UI state. */
    }
    this.rowBounds = {};
    this.reposFolded = new Set();
    try {
      this.reposFolded = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]"));
    } catch {
      /* Ignore invalid saved UI state. */
    }
    this.worktreeCount = {};
    this.worktreeIds = {}; // repo key -> its worktree spaces' ids
    this.agents = new SpaceAgents();
    // The list scrolls itself so it can follow the active space: Herdr can't move
    // a native scroll area from code. Heights come from sized().
    this.offset = 0;
    this.viewH = 0;
    this.contentH = 0;
    this.sizes = {};
    this.owners = [];
    // Spaces whose agents are folded away (a repo's row folds through reposFolded).
    this.agentsFolded = new Set();
    try {
      this.agentsFolded = new Set(JSON.parse(localStorage.getItem("spaces.agents-folded") ?? "[]"));
    } catch {
      /* Ignore invalid saved UI state. */
    }
    this.folded = new Set();
    try {
      this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    } catch {
      /* Ignore invalid saved UI state. */
    }
    // "better-sidebar.new-group" in keys.json asks for a new folder's name.
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "new-group") openNameDialog(null, this.focusedMachine());
    });
    this.revealed = spaces().find((w) => w.active)?.id ?? null;
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  // Read the installed mod.json once; Herdr restarts the mod when it changes.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("better-sidebar", DEFAULT_SETTINGS);
      this.settings = settings;
      for (const problem of problems) console.warn(`better-sidebar mod.json settings: ${problem}`);
      cx.notify();
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const active = sp.find((w) => w.active)?.id ?? null;
    if (active !== this.revealed) {
      this.revealed = active;
      if (active) this.reveal(active, cx);
    }
    this.updateColors(sp);
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    this.publishParents(sp, ps);
    this.publishOrder();
    const places = sp.map((s) => {
      const tabs = new Set((s.tabs ?? []).map((tab) => tab.id));
      const folder = spaceFolder(s, ps);
      return {
        folder,
        machine: s.machine,
        branch:
          ps.find((p) => tabs.has(p.tab) && p.cwd === folder)?.branch ??
          this.git[prPlaceKey(s.machine, folder)]?.branch,
      };
    });
    if (this.settings.pull_request_status) this.prObserver.refresh(places, cx);
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    this.askIcons(now, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, spaceList, paneList) {
    const places = Object.create(null);
    for (const space of spaceList) places[space.id] = checkoutKey(space, paneList);
    const used = new Set(Object.values(places).filter((key) => JSON.parse(key)[1]));
    const due = new Set([...used].filter((key) => !(key in this.git)));

    this.addChangedBranches(due, now, spaceList, paneList, places);
    this.addRevisited(due, places, used);
    this.addFinishedWork(due, spaceList, paneList, places, used);
    this.addReconnected(due, used);
    this.addFallbacks(due, now, used);
    return due;
  }

  // Branch names arrive live from Herdr. Refresh richer Git metadata promptly
  // after a checkout, without waiting for the slower fallback poll.
  addChangedBranches(due, now, spaceList, paneList, places) {
    for (const space of spaceList) {
      const key = places[space.id];
      const folder = spaceFolder(space, paneList);
      const tabIDs = new Set((space.tabs ?? []).map((tab) => tab.id));
      const branch = paneList.find((pane) => tabIDs.has(pane.tab) && pane.cwd === folder)?.branch;
      const stale = branch && !this.unsure.has(key) && this.git[key]?.branch !== branch;
      if (stale && now - (this.checked[key] ?? 0) > 1000) due.add(key);
    }
  }

  // Returning to a previously visited folder still requires a fresh read.
  addRevisited(due, places, used) {
    for (const [id, key] of Object.entries(places)) {
      if (this.at[id] && this.at[id] !== key && used.has(key)) due.add(key);
    }
    this.at = places;
  }

  // A completed command may have changed sibling worktrees' ahead/behind too.
  addFinishedWork(due, spaceList, paneList, places, used) {
    const spaceByTab = {};
    for (const space of spaceList) {
      for (const tab of space.tabs ?? []) spaceByTab[tab.id] = space;
    }
    const busy = {};
    for (const pane of paneList) {
      if (!pane.terminal || !spaceByTab[pane.tab]) continue;
      busy[pane.pane] = pane.status === "working" || !(pane.program?.shell || pane.program?.agent);
      if (this.busy[pane.pane] && !busy[pane.pane]) {
        const key = places[spaceByTab[pane.tab].id];
        this.sameRepo(key, used).forEach((k) => due.add(k));
      }
    }
    this.busy = busy;
  }

  addReconnected(due, used) {
    for (const machine of machines()) {
      const ready = machine.layout === "ready";
      if (ready && this.ready[machine.name] === false) {
        for (const key of used) if (JSON.parse(key)[0] === machine.name) due.add(key);
      }
      this.ready[machine.name] = ready;
    }
  }

  addFallbacks(due, now, used) {
    if (!window().active) return;
    const every = duration(this.settings.git.retry_after, GIT_FALLBACK_MS);
    for (const key of used) {
      const watched = this.git[key] || this.unsure.has(key);
      const shown = !this.folded.has(JSON.parse(key)[0]);
      if (watched && shown && now - (this.checked[key] ?? 0) > every) due.add(key);
    }
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0)
          this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
        for (const m of this.machines) {
          if (m.state !== "connected" || this.remoteHome[m.name]) continue;
          const h = await exec("printenv", ["HOME"], { on: m.name }).catch(() => null);
          if (h?.code === 0 && h.stdout.trim()) this.remoteHome[m.name] = h.stdout.trim();
        }
      } catch {
        // Keep the last machine list if core is temporarily unavailable.
      }
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(
        Object.values(this.git)
          .filter(Boolean)
          .map((g) => JSON.parse(g.repo))
          .filter(([on]) => !on)
          .map(([, repo]) => repo),
      );
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // ── Read-only Git metadata and local watches ──────────────────────────────

  // One place's git. A failure to ask (the machine is away) keeps what it showed.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const info = await readCheckout(cwd, on);
      this.git[key] = info;
      if (info && !on) this.watch(JSON.parse(info.repo)[1], cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo))
            this.refreshGit(
              Object.keys(this.git).filter((k) => this.git[k]?.repo === mine),
              cx,
            );
        }
      } catch {
        this.watching.delete(repo);
      }
    });
  }

  // Each repo's icon: looked up once, again every 10 min, or a minute after a failure.
  askIcons(now, cx) {
    for (const g of Object.values(this.git)) {
      if (!g?.repo) continue;
      const at = this.iconAt[g.repo];
      if (at?.busy || now - (at?.t ?? 0) < (at?.failed ? 60000 : 600000)) continue;
      this.iconAt[g.repo] = { busy: true };
      const [on] = JSON.parse(g.repo);
      cx.spawn(async (cx) => {
        const found = await findRepoIcon(repoRoot(g), on).then((v) => ({ v }), () => null);
        this.iconAt[g.repo] = { t: Date.now(), failed: !found };
        if (!found || (this.repoIcons[g.repo] ?? null) === found.v) return;
        if (found.v) this.repoIcons[g.repo] = found.v;
        else delete this.repoIcons[g.repo];
        localStorage.setItem("repo.icons", JSON.stringify(this.repoIcons));
        cx.notify();
      });
    }
  }

  // ── Space navigation and worktree/machine grouping ────────────────────────

  // Tells the agents block, a separate copy, which main space each space belongs
  // to: the repository's open main checkout, else the repository's folder name.
  publishParents(sp, ps) {
    const known = sp.map((w) => ({ w, g: this.git[checkoutKey(w, ps)] })).filter((r) => r.g);
    const parents = {};
    for (const { w, g } of known) {
      const main = known.find((r) => r.g.repo === g.repo && !r.g.linked);
      const folder = JSON.parse(g.repo)[1]
        .replace(/\/\.git\/?$/, "")
        .split("/")
        .pop();
      parents[w.id] = { key: g.repo, label: (main && shownName(main.w, main.g)) || folder };
    }
    const text = JSON.stringify(parents);
    if (text === this.parentsText) return;
    this.parentsText = text;
    setShared("better-sidebar.space-parents", parents);
  }

  // Space ids top to bottom as drawn: machines, your groups, repos with their
  // worktrees. Folded rows keep their spaces in place.
  navOrder() {
    const { projects } = readGroups();
    const units = [];
    for (const r of this.drawn ?? []) {
      const ids = this.rowIds(r);
      if (r.tree && units.length) units[units.length - 1].ids.push(...ids);
      else units.push({ m: r.w.machine ?? null, key: this.keyOf(r), ids });
    }
    const inGroup = (u, id) => projects[u.key] === id;
    const byGroup = (us, m) => {
      const shown = this.shownGroups(m);
      return [...shown.flatMap((gr) => us.filter((u) => inGroup(u, gr.id))), ...us.filter((u) => !shown.some((gr) => inGroup(u, gr.id)))];
    };
    const remote = [...new Set(units.map((u) => u.m).filter(Boolean))].sort();
    return [...new Set([null, ...remote].flatMap((m) => byGroup(units.filter((u) => u.m === m), m)).flatMap((u) => u.ids))];
  }

  // When the active space changes (keys, agent.next, a click), bring its row on screen.
  scrollToActive() {
    const active = spaces().find((w) => w.active)?.id;
    if (!active || active === this.scrolledTo || !this.viewH) return;
    const at = this.owners.findIndex((o) => o.ids.includes(active));
    const h = (key) => this.sizes[key];
    if (at < 0 || this.owners.slice(0, at + 1).some((o) => h(o.key) == null)) return;
    let top = this.owners.slice(0, at).reduce((sum, o) => sum + h(o.key), 0);
    let height = h(this.owners[at].key);
    // Inside a group block: past its 4px top margin and header, to the row itself.
    const sub = this.owners[at].sub;
    const j = sub ? sub.rows.findIndex((r) => r.ids.includes(active)) : -1;
    if (j >= 0 && [sub.head, ...sub.rows.slice(0, j + 1).map((r) => r.key)].every((k) => h(k) != null)) {
      top += 4 + h(sub.head) + sub.rows.slice(0, j).reduce((sum, r) => sum + h(r.key), 0);
      height = h(sub.rows[j].key);
    }
    this.scrolledTo = active;
    const pad = 8;
    if (top - pad < this.offset) this.offset = top - pad;
    else if (top + height + pad > this.offset + this.viewH) this.offset = Math.min(top - pad, top + height + pad - this.viewH);
    this.clampScroll();
  }

  clampScroll() {
    this.offset = Math.max(0, Math.min(this.offset, this.contentH - this.viewH));
  }

  scrollBy(dy, cx) {
    const before = this.offset;
    this.offset += dy;
    this.clampScroll();
    if (this.offset !== before) cx.notify();
  }

  // The scrollbar thumb, drawn by hand since the list scrolls itself; drag it to scroll.
  thumb(t) {
    const h = Math.max(24, (this.viewH * this.viewH) / this.contentH);
    const y = ((this.viewH - h) * this.offset) / (this.contentH - this.viewH);
    return div().id("spaces-thumb").absolute().right(2).top(y).w(6).h(h).rounded(3).bg(t.dim + "66")
      .on_mouse_down("left", (e) => {
        this.drag = { y: e.position.y, from: this.offset, k: (this.contentH - this.viewH) / (this.viewH - h) };
      });
  }

  // Shares navOrder for better-sidebar.next-space / prev-space (views/space-nav.js).
  publishOrder() {
    const order = this.navOrder();
    const text = JSON.stringify(order);
    if (!order.length || text === this.orderText) return;
    this.orderText = text;
    setShared(ORDER_KEY, order);
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({
      mod: "my-menu",
      kind: "popup",
      width: 200,
      height: 300,
      props: { tab: "space", target: { id: w.id } },
    });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces();
    const ps = panes();
    const ready = (w) =>
      this.shown.has(w.id) ||
      checkoutKey(w, ps) in this.git ||
      Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp
      .map((w, i) => ({ w, i, g: this.git[checkoutKey(w, ps)] ?? null }))
      .filter((r) => this.shown.has(r.w.id));
    // Each space's folder unit (a repo, or the space itself) and where those units live.
    this.unitKey = {};
    this.unitMachine = {};
    for (const r of list) {
      const k = this.keyOf(r);
      this.unitKey[r.w.id] = k;
      this.unitMachine[k] = r.w.machine ?? null;
    }
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    this.worktreeCount = {};
    this.worktreeIds = {};
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      this.worktreeCount[r.g.repo] = kids.length;
      this.worktreeIds[r.g.repo] = kids.map((k) => k.w.id);
      // A folded repo keeps its worktrees out of the list (its row's chevron).
      if (this.reposFolded.has(r.g.repo)) continue;
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    this.drawn = out;
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  // A drawn row's spaces: itself, and a folded repo's worktrees.
  rowIds(r) {
    return [r.w.id, ...(r.g && !r.tree && this.reposFolded.has(r.g.repo) ? (this.worktreeIds[r.g.repo] ?? []) : [])];
  }

  // Wraps an element to record its height under `key`.
  sized(el, key) {
    return v_flex().id(`sized-${key}`).flex_none().on_size_change((s) => {
      this.sizes[key] = s.height;
    }).child(el);
  }

  // A top-level list child and the spaces it holds; `sub` places rows inside a group block.
  own(el, ids, sub = null) {
    const key = `own-${this.owners.length}`;
    this.owners.push({ key, ids, sub });
    return this.sized(el, key);
  }

  grouped(t, collapsed) {
    const rows = this.ordered();
    this.owners = [];
    const draw = (r) => this.own(collapsed ? this.compact(r, t) : this.row(r, t), this.rowIds(r));
    const drawAll = (rs, m) => (collapsed ? rs.map(draw) : this.groupedRows(rs, t, m));
    const remote = [
      ...new Set([
        ...rows.map((r) => r.w.machine).filter(Boolean),
        ...this.machines.map((m) => m.name),
      ]),
    ].sort();
    if (!remote.length) {
      return this.machineLoading(null) && !rows.length
        ? [this.own(this.loadingRow(null, t, collapsed), [])]
        : drawAll(rows, null);
    }
    return [null, ...remote].flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const folded = this.folded.has(m);
      const ids = mine.flatMap((r) => this.rowIds(r));
      const head = this.own(this.machineHeader(m, t, collapsed, ids), folded ? ids : []);
      const hint = this.dragging && this.blocked === m && !collapsed ? [this.own(this.blockedHint(m, t), [])] : [];
      if (folded) return [head, ...hint];
      if (mine.length) return [head, ...hint, ...drawAll(mine, m)];
      const placeholder = this.machineLoading(m)
        ? this.loadingRow(m, t, collapsed)
        : this.newSpaceRow(m, t, collapsed);
      return [head, this.own(placeholder, [])];
    });
  }

  // ── Your project groups (views/groups.js) ─────────────────────────────────

  // Repositories open as spaces, for the "Add projects" picker.
  knownProjects() {
    const ps = panes();
    const seen = new Map();
    for (const w of spaces()) {
      const g = this.git[checkoutKey(w, ps)];
      if (!g?.repo) {
        if (this.shown.has(w.id)) seen.set(`space:${w.id}`, { key: `space:${w.id}`, name: w.machine ? `${w.name} (${w.machine})` : w.name });
        continue;
      }
      const label = w.machine ? `${g.name} (${w.machine})` : g.name;
      if (!seen.has(g.repo) || !g.linked) seen.set(g.repo, { key: g.repo, name: label });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Going to a space (a key, a click, agent.next) opens what hides it: its machine, folder and repo.
  reveal(id, cx) {
    const w = spaces().find((x) => x.id === id);
    if (!w) return;
    const m = w.machine ?? null;
    let changed = false;
    if (this.folded.delete(m)) {
      localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
      changed = true;
    }
    const key = this.unitKey?.[id];
    const s = readGroups();
    const group = key && s.projects[key];
    if (group && s.groups.some((g) => g.id === group) && isFolded(s, group, m)) setFold(group, m, false);
    const g = this.git[checkoutKey(w, panes())];
    if (g?.linked && this.reposFolded.delete(g.repo)) {
      localStorage.setItem("repos.folded", JSON.stringify([...this.reposFolded]));
      changed = true;
    }
    if (changed) cx.notify();
  }

  // A space's folder unit: its repo (worktrees go with their repo), or the space itself.
  keyOf(r) {
    return r.g?.repo ?? `space:${r.w.id}`;
  }

  focusedMachine() {
    return spaces().find((s) => s.id === focused()?.space)?.machine ?? null;
  }

  // The machine a drag started on; undefined while nothing is dragged.
  dragMachine() {
    return this.pressed == null ? undefined : (spaces()[this.pressed]?.machine ?? null);
  }

  // Machines holding a folder's open units.
  groupMachines(id) {
    const { projects } = readGroups();
    const at = this.unitMachine ?? {};
    return [...new Set(Object.keys(projects).filter((k) => projects[k] === id && k in at).map((k) => at[k]))];
  }

  // Folders under machine m: those holding its units, and an empty one under the machine it was made on.
  shownGroups(m) {
    const { groups, projects } = readGroups();
    const at = this.unitMachine ?? {};
    return groups.filter((g) => {
      const keys = Object.keys(projects).filter((k) => projects[k] === g.id && k in at);
      return keys.some((k) => at[k] === m) || (!keys.length && (g.home ?? null) === m);
    });
  }

  // A machine's rows under its folders, in folder order; Unfiled follows. While one of its
  // spaces is dragged, a zone at the end makes a new folder with it.
  groupedRows(rows, t, m) {
    const s = readGroups();
    const draw = (r) => this.own(this.row(r, t), this.rowIds(r));
    const shown = this.shownGroups(m);
    const units = [];
    for (const r of rows) {
      if (r.tree && units.length) units[units.length - 1].rows.push(r);
      else units.push({ key: this.keyOf(r), rows: [r] });
    }
    const dragging = this.dragging && this.dragMachine() === m;
    const out = [];
    for (const group of shown) {
      const mine = units.filter((u) => s.projects[u.key] === group.id).flatMap((u) => u.rows);
      const folded = isFolded(s, group.id, m);
      const tag = `${group.id}@${m ?? "local"}`;
      const tint = groupTint(t, group.color);
      const ids = mine.flatMap((r) => this.rowIds(r));
      // The header and its projects share one block, tinted with the folder's color.
      const sub = folded ? null : { head: `ghead-${tag}`, rows: mine.map((r) => ({ key: `grow-${r.w.id}`, ids: this.rowIds(r) })) };
      out.push(this.own(v_flex().id(`group-block-${tag}`).flex_none().mt(4).rounded(9)
        .when(Boolean(tint), (el) => el.bg(tint).pb(folded ? 0 : 4))
        .child(this.sized(this.groupHeader(group, m, ids, folded, shown, t), `ghead-${tag}`))
        .when(!folded, (el) => el.child(mine.length
          ? v_flex().flex_none().pl(16).children(mine.map((r) => this.sized(this.row(r, t), `grow-${r.w.id}`)))
          : this.emptyGroupRow(group, m, t))), ids, sub));
    }
    const rest = units.filter((u) => !shown.some((g) => g.id === s.projects[u.key])).flatMap((u) => u.rows);
    // Loose spaces sit beside the folders; only a drag shows where to take one out.
    if (shown.length && dragging) out.push(this.own(this.unfiledRow(m, t), []));
    out.push(...rest.map(draw));
    if (dragging) out.push(this.own(this.newFolderZone(m, t), []));
    return out;
  }

  groupHeader(group, m, ids, folded, shown, t) {
    const tag = `${group.id}@${m ?? "local"}`;
    const target = this.isTarget({ group: group.id, m });
    const others = this.groupMachines(group.id).filter((x) => x !== m).map((x) => x ?? "This computer");
    const summary = folded && inlineAgents() ? this.agents.folderSummary(ids, t) : null;
    return h_flex()
      .id(`group-${tag}`)
      .h(30)
      .flex_none()
      .pl(6)
      .pr(4)
      .gap(7)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(target, (el) => el.bg(t.accent + "33").border_1().border_color(t.accent))
      .when(!target, (el) => el.hover((s) => s.bg(t.hover)))
      // A double-click renames: its second click puts the fold back first.
      .on_click((e) => {
        toggleFold(group.id, m);
        if (e.click_count === 2) openNameDialog(group.id);
      })
      .on_mouse_down("right", () => this.groupMenu(group, m, shown))
      .on_mouse_move((_e, cx) => this.dragOver({ group: group.id, m }, m, cx, folded))
      .on_mouse_up("left", (_e, cx) => this.dropOn({ group: group.id, m }, cx))
      .child(Icon(`chevron-${folded ? "right" : "down"}`, 12).text_color(t.dim))
      .child(Icon("folder", 15).text_color((group.color && t[group.color]) || t.muted))
      .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground)
        .tooltip(others.length ? `${group.name} · also on ${others.join(", ")}` : group.name).child(group.name))
      .child(div().flex_1())
      .when(Boolean(summary), (el) => el.child(summary))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(String(ids.length)))
      .child(IconButton({ id: `group-menu-${tag}`, icon: "ellipsis", label: "Folder options", iconSize: 13, muted: true,
        onClick: () => this.groupMenu(group, m, shown) }));
  }

  groupMenu(group, m, shown) {
    openGroupMenu(group.id, this.knownProjects(), m, shown.map((g) => g.id));
  }

  emptyGroupRow(group, m, t) {
    const target = this.isTarget({ group: group.id, m });
    return div()
      .id(`group-empty-${group.id}@${m ?? "local"}`)
      .h(26)
      .flex_none()
      .mx(4)
      .pl(27)
      .flex()
      .items_center()
      .rounded(6)
      .text_size(TEXT.small)
      .text_color(target ? t.foreground : t.dim)
      .when(target, (el) => el.border_1().border_color(t.accent))
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => openProjectPicker(group.id, this.knownProjects()))
      .on_mouse_move((_e, cx) => this.dragOver({ group: group.id, m }, m, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOn({ group: group.id, m }, cx))
      .child(this.dragging ? "Drop it here" : "Empty · drag a space here");
  }

  unfiledRow(m, t) {
    const target = this.isTarget({ unfiled: true, m });
    return h_flex()
      .id(`unfiled-${m ?? "local"}`)
      .h(30)
      .mt(8)
      .mb(2)
      .px(10)
      .flex_none()
      .items_center()
      .rounded(8)
      .text_size(TEXT.small)
      .border_1()
      .border_dashed()
      .border_color(target ? t.accent : t.input)
      .text_color(target ? t.foreground : t.muted)
      .when(target, (el) => el.bg(t.accent + "1f"))
      .on_mouse_move((_e, cx) => this.dragOver({ unfiled: true, m }, m, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOn({ unfiled: true, m }, cx))
      .child(div().flex_1().child("Drop here to take it out of its folder"));
  }

  newFolderZone(m, t) {
    const target = this.isTarget({ fresh: true, m });
    return h_flex()
      .id(`new-folder-${m ?? "local"}`)
      .h(38)
      .mt(10)
      .flex_none()
      .gap(8)
      .items_center()
      .justify_center()
      .rounded(8)
      .border_1()
      .border_dashed()
      .border_color(target ? t.accent : t.input)
      .when(target, (el) => el.bg(t.accent + "1f"))
      .text_size(TEXT.small)
      .text_color(target ? t.foreground : t.muted)
      .on_mouse_move((_e, cx) => this.dragOver({ fresh: true, m }, m, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOn({ fresh: true, m }, cx))
      .child(Icon("folder-plus", 14))
      .child("Drop to make a new folder");
  }

  // Shown under a machine while a space from another machine is dragged over it.
  blockedHint(m, t) {
    const from = this.dragMachine() ?? "This computer";
    const name = spaces()[this.pressed]?.name ?? "This space";
    return div()
      .id(`blocked-${m ?? "local"}`)
      .flex_none()
      .mx(4)
      .my(3)
      .px(10)
      .py(6)
      .rounded(7)
      .border_1()
      .border_dashed()
      .border_color(t.ansi1 + "88")
      .bg(t.ansi1 + "1a")
      .text_size(TEXT.caption)
      .text_color(t.ansi1)
      .child(`${name} lives on ${from}. It can only be filed under ${from}.`);
  }

  isTarget(target) {
    return Boolean(this.dragging) && JSON.stringify(this.target) === JSON.stringify(target);
  }

  // A drag over a folder header, Unfiled or the new-folder zone. Another machine's
  // section refuses it; a folded folder opens after a moment.
  dragOver(target, m, cx, folded = false) {
    if (this.pressed == null) return;
    const ok = this.dragMachine() === m;
    const next = ok ? target : null;
    const blocked = ok ? null : m;
    if (this.dragging && JSON.stringify(next) === JSON.stringify(this.target) && this.blocked === blocked && this.over === null) return;
    this.target = next;
    this.blocked = blocked;
    this.over = null;
    this.dragging = true;
    if (ok && folded && target.group) {
      const want = JSON.stringify(target);
      cx.timer.after(650, (cx) => {
        if (JSON.stringify(this.target) !== want || !isFolded(readGroups(), target.group, m)) return;
        setFold(target.group, m, false);
        cx.notify();
      });
    }
    cx.notify();
  }

  dropOn(target, cx) {
    if (this.pressed == null || !this.isTarget(target)) return;
    const key = this.unitKey?.[spaces()[this.pressed]?.id];
    if (key && target.group) fileUnder(key, target.group);
    else if (key && target.unfiled) fileUnder(key, null);
    else if (key && target.fresh) openNameDialog(newGroupWith(key, target.m), target.m);
    this.endDrag();
    cx.notify();
  }

  endDrag() {
    this.pressed = null;
    this.over = null;
    this.target = null;
    this.blocked = null;
    this.dragging = false;
  }

  // A new space starts at its machine's home, never in the focused terminal's folder:
  // from a worktree that would open a second space on it, and removing either deletes both.
  newSpace(m) {
    const folder = m ? this.remoteHome[m] : home();
    run("space.new", { machine: m ?? "", ...(folder ? { folder } : {}) });
  }

  machineLoading(m) {
    const layout = machines().find((k) => k.name === m)?.layout;
    return (
      layout === "loading" ||
      (!layout && this.machines.some((k) => k.name === m && k.state === "connected")) ||
      spaces().some((s) => (s.machine ?? null) === m && !this.shown.has(s.id))
    );
  }

  loadingRow(m, t, collapsed) {
    return div()
      .id(`machine-loading-${m ?? "local"}`)
      .h(28)
      .flex_none()
      .px(8)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .child(collapsed ? "…" : "Loading…");
  }

  newSpaceRow(m, t, collapsed) {
    return h_flex()
      .id(`machine-new-${m ?? "local"}`)
      .h(28)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => this.newSpace(m))
      .child(Icon("plus", 12))
      .when(!collapsed, (el) => el.child("New space there"));
  }

  // Each machine is its own section: a bold bar, ruled off from the machine above.
  machineHeader(m, t, collapsed, ids = []) {
    const machine = this.machines.find((k) => k.name === m);
    const connected = !m || machine?.state === "connected";
    const head = h_flex()
      .id(`machine-${m ?? "local"}`)
      .h(26)
      .flex_none()
      .px(collapsed ? 2 : 8)
      .gap(7)
      .items_center()
      .text_size(TEXT.caption)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_move((_e, cx) => this.dragOver({ machine: true, m }, m, cx))
      .on_click((_e, cx) => {
        if (!this.folded.delete(m)) this.folded.add(m);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(Icon(m ? "server" : "monitor", 13));
    if (collapsed) return head;
    const folded = this.folded.has(m);
    const summary = folded && inlineAgents() ? this.agents.folderSummary(ids, t) : null;
    // Laid out like a folder header (chevron first), a step bolder; the dot is green while connected.
    const bar = h_flex()
      .id(`machine-${m ?? "local"}`)
      .h(30)
      .flex_none()
      .pl(6)
      .pr(2)
      .gap(7)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_move((_e, cx) => this.dragOver({ machine: true, m }, m, cx))
      .on_click((_e, cx) => {
        if (!this.folded.delete(m)) this.folded.add(m);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(Icon(`chevron-${folded ? "right" : "down"}`, 12).text_color(t.dim))
      .child(Icon(m ? "server" : "monitor", 14).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(m ?? "This computer"))
      .when(Boolean(summary), (el) => el.child(summary))
      .when(!connected, (el) =>
        el.child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child((machine?.state ?? "asleep").replace(/_/g, " "))),
      )
      .when(folded, (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(String(ids.length))))
      .child(div().size(6).mx(2).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim)
        .tooltip(connected ? "Connected" : (machine?.state ?? "asleep").replace(/_/g, " ")))
      .when(connected, (el) => el.child(IconButton({ id: `machine-add-${m ?? "local"}`, icon: "plus", label: `New space on ${m ?? "this computer"}`,
        iconSize: 13, muted: true, onClick: () => this.newSpace(m) }).size(22)));
    // One rule between machines; none above the first.
    return v_flex()
      .id(`machine-section-${m ?? "local"}`)
      .flex_none()
      .when(m !== null, (el) => el.child(div().h(1).mx(4).mt(10).mb(6).bg(t.border)))
      .child(bar);
  }

  // ── Branch and PR descriptions ───────────────────────────────────────────

  // The checkout's branch; null outside a repository.
  shownBranch(g) {
    if (!g) return null;
    return g.branch === "(detached)" ? "detached" : (g.branch ?? "detached");
  }

  // The branch and PR must describe the same checkout: the space's first
  // terminal, matching Herdr's space naming and worktree grouping semantics.
  checkoutStatus(w) {
    const ps = panes();
    const folder = spaceFolder(w, ps);
    const tabs = new Set((w.tabs ?? []).map((tab) => tab.id));
    const branch =
      ps.find((pane) => tabs.has(pane.tab) && pane.cwd === folder)?.branch ??
      this.git[prPlaceKey(w.machine, folder)]?.branch;
    const status = this.prObserver.entries.get(prPlaceKey(w.machine, folder));
    return status?.branch === branch ? status : null;
  }

  checkoutPRs(w) {
    return this.checkoutStatus(w)?.prs ?? [];
  }

  // Keep ordinary clicks available to the enclosing space row. Modified link
  // presses must stop both mouse events: the row selects on mouse-up, not click.
  isPRLinkClick(event) {
    return window().platform === "macos"
      ? Boolean(event.modifiers?.platform)
      : Boolean(event.modifiers?.control || event.modifiers?.platform);
  }

  // The issues mod's viewer for an issue or PR; Cmd/Ctrl-click opens GitHub instead.
  // Presses stop here: the row selects (and drags) on mouse-up.
  linkBadge(id, w, { repo, number, pr, url, title, label, color, icon, compact }) {
    const shortcut = window().platform === "macos" ? "Cmd" : "Ctrl";
    return h_flex()
      .id(id)
      .gap(3)
      .flex_none()
      .items_center()
      .cursor_pointer()
      .text_color(color)
      .tooltip(`${repo}#${number} · ${label}\n${title}\nClick to view · ${shortcut}-click for GitHub`)
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.pressed = null;
        this.over = null;
      })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((event, cx) => {
        cx.stop_propagation();
        if (this.isPRLinkClick(event)) return cx.open_url(url);
        openOverlay({ mod: "issues", kind: "dialog", width: 0.86, height: 0.9, props: { issue: {
          repo, number, on: null, pr, folder: spaceFolder(w, panes()), machine: w.machine ?? null } } });
      })
      .child(Icon(icon).size(13).flex_none())
      .when(!compact, (el) => el.child(div().text_size(TEXT.caption).child(`#${number}`)));
  }

  issueBadge(w, t) {
    const issue = this.checkoutStatus(w)?.issue;
    if (!issue) return null;
    const open = issue.state === "OPEN";
    return this.linkBadge(`space-issue-${w.id}-${issue.repository}-${issue.number}`, w, {
      repo: issue.repository, number: issue.number, pr: false, url: issue.url, title: issue.title,
      label: open ? "Open issue" : "Closed issue", color: open ? t.ansi2 : t.ansi5, icon: open ? "issue" : "issue-closed",
    });
  }

  prBadge(w, t, compact = false) {
    const prs = this.checkoutPRs(w);
    if (!prs.length) return null;
    const badge = h_flex().gap(5).flex_none().items_center();
    // Keep the sidebar width bounded when a branch targets several base repos.
    for (const pr of prs.slice(0, 1)) {
      const status = prAppearance(pr, t);
      badge.child(this.linkBadge(`space-pr-${w.id}-${pr.repository}-${pr.number}`, w, {
        repo: pr.repository, number: pr.number, pr: true, title: pr.title, label: status.label,
        url: pr.url || `https://github.com/${pr.repository}/pull/${pr.number}`, color: status.color, icon: status.icon, compact,
      }));
    }
    if (!compact && prs.length > 1)
      badge.child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .tooltip(
            prs
              .slice(1)
              .map((pr) => `${pr.repository}#${pr.number} · ${pr.title}`)
              .join("\n"),
          )
          .child(`+${prs.length - 1}`),
      );
    return badge;
  }

  // Whether a row needs the line under its name.
  hasDetail(w, g) {
    const status = this.checkoutStatus(w);
    const moved = w.active && (g?.ahead > 0 || g?.behind > 0);
    return Boolean(this.shownBranch(g) || moved || status?.prs.length || status?.issue || status?.error || this.ports(w).length || this.foldedSummary(w, g) || this.sleeping(w) || noteOf(w));
  }

  // Set by the hibernate mod while a space is asleep: { at, count }.
  sleeping(w) {
    return shared("hibernate.sleeping")?.[w.id] ?? null;
  }

  // Ports listening in this space's checkout, published by the live-ports mod; listed in the hover card.
  ports(w) {
    return shared("live-ports")?.bySpace?.[w.id] ?? [];
  }

  // Under the name: the branch on the left; ahead/behind and the PR on the right.
  detailLine(w, g, t, tree) {
    const status = this.checkoutStatus(w);
    const branch = this.shownBranch(g);
    const ports = this.ports(w);
    return h_flex()
      .id(`space-detail-${w.id}`)
      .h(20)
      .pl(tree ? 44 : 27)
      .gap(6)
      .items_center()
      .text_size(TEXT.label)
      .text_color(t.dim)
      .when(Boolean(branch), (el) =>
        el.child(div().min_w(0).truncate().tooltip(branch).child(branch)),
      )
      // The repo's main folder, as opposed to a linked worktree.
      .when(Boolean(g) && !g.linked, (el) => el.child(Badge("primary")))
      .child(div().flex_1())
      .when(w.active && g?.ahead > 0, (el) => el.child(Badge(`\u2191${g.ahead}`)))
      .when(w.active && g?.behind > 0, (el) => el.child(Badge(`\u2193${g.behind}`)))
      // Its note (views/notes.js): the text on hover, a click edits it.
      .when(Boolean(noteOf(w)), (el) =>
        el.child(
          div()
            .id(`space-note-${w.id}`)
            .flex_none()
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .tooltip(noteOf(w))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => openNote(w))
            .child(Icon("note", 13)),
        ),
      )
      .when(ports.length > 0, (el) =>
        el.child(
          div()
            .id(`space-ports-${w.id}`)
            .flex_none()
            .text_color(t.muted)
            .tooltip(`${ports.length} live port${ports.length === 1 ? "" : "s"}: ${ports.map((p) => p.port).join(", ")}`)
            .child(Icon("plug", 13)),
        ),
      )
      .when(Boolean(status?.issue), (el) => el.child(this.issueBadge(w, t)))
      .when(Boolean(status?.prs.length), (el) => el.child(this.prBadge(w, t)))
      .when(Boolean(status?.error), (el) =>
        el.child(
          div()
            .flex_none()
            .text_size(TEXT.caption)
            .tooltip(`PR refresh failed: ${status.error}`)
            .child(status.prs.length ? "· stale" : "PR unavailable"),
        ),
      )
      .when(Boolean(this.foldedSummary(w, g)), (el) => el.child(this.foldedSummary(w, g)))
      .when(Boolean(this.sleeping(w)), (el) =>
        el.child(
          h_flex()
            .id(`space-asleep-${w.id}`)
            .flex_none()
            .gap(3)
            .items_center()
            .text_size(TEXT.caption)
            .text_color(t.muted)
            .tooltip(`Asleep · ${this.sleeping(w).count} terminal${this.sleeping(w).count === 1 ? "" : "s"} stopped · Wake from the space menu`)
            .child(Icon("moon", 12))
            .child("Asleep"),
        ),
      );
  }

  // ── Agents inside spaces (views/space-agents.js) ─────────────────────────

  isMain(g) {
    return Boolean(g?.repo) && !g.linked;
  }

  // A repo's row folds its worktrees and agents together; other rows fold their agents.
  agentsHidden(w, g) {
    return this.isMain(g) && this.worktreeCount[g.repo] ? this.reposFolded.has(g.repo) : this.agentsFolded.has(w.id);
  }

  // The spaces a folded row stands for: itself, and a repo's worktrees.
  coveredSpaces(w, g) {
    return [w.id, ...(this.isMain(g) ? (this.worktreeIds[g.repo] ?? []) : [])];
  }

  foldedSummary(w, g) {
    if (!inlineAgents() || !this.agentsHidden(w, g)) return null;
    return this.agents.summary(this.coveredSpaces(w, g), theme());
  }

  hasAgents(w, g) {
    return inlineAgents() && this.coveredSpaces(w, g).some((id) => this.agents.has(id));
  }

  toggleAgents(w, g, cx) {
    if (this.isMain(g) && this.worktreeCount[g.repo]) {
      if (!this.reposFolded.delete(g.repo)) this.reposFolded.add(g.repo);
      localStorage.setItem("repos.folded", JSON.stringify([...this.reposFolded]));
    } else {
      if (!this.agentsFolded.delete(w.id)) this.agentsFolded.add(w.id);
      localStorage.setItem("spaces.agents-folded", JSON.stringify([...this.agentsFolded]));
    }
    cx.notify();
  }

  // The header's switch between agents in spaces and the Agents panel.
  agentsSwitch(t) {
    const on = inlineAgents();
    return h_flex()
      .id("inline-agents")
      .h(26)
      .px(7)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(TEXT.caption)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.hover).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.dim))
      .tooltip(on ? "Agents show in spaces · click for the Agents panel" : "Show agents in spaces")
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => setInlineAgents(!on, findNode(layout(), "agents")))
      .child(Icon("bot", 13))
      .child("Agents");
  }

  // ── Expanded/compact rows and sidebar rendering ──────────────────────────

  row({ w, i, g, tree }, t) {
    const detail = this.hasDetail(w, g);
    const row = v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }) + (detail ? 20 : 0))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .on_mouse_down("right", () => this.menu(w))
      .child(this.rowTitle(w, g, tree, t))
      .when(detail, (el) => el.child(this.detailLine(w, g, t, Boolean(tree))));
    if (this.pressed !== null && this.over === i && this.pressed !== i)
      row.child(this.dropLine(i, t));
    // The wrapper drives the hover card; the row itself handles dragging.
    const wrap = v_flex()
      .id(`space-wrap-${w.id}`)
      .flex_none()
      .on_mouse_move((e, cx) => {
        if (e.bounds) this.rowBounds[w.id] = e.bounds;
        // Hovered by a scroll, then the pointer moved: the card can come now.
        if (this.hovering === w.id && !this.hoverToken && !this.card) this.scheduleCard(w, cx);
      })
      .on_hover((hovered, cx) => this.hoverRow(w, g, hovered, cx))
      .child(this.withDragging(row, w, i));
    if (!inlineAgents() || this.agentsHidden(w, g) || !this.agents.has(w.id)) return wrap;
    // Agents line up with the space's name: past the avatar, or past a worktree's branch icon.
    return v_flex().id(`space-block-${w.id}`).flex_none().pb(2)
      .child(wrap)
      .children(this.agents.rows(w.id, t, tree ? 52 : 35));
  }

  // ── Hover card: the row's PR, issue and ports (views/card.js) ────────────

  // Rows slide under a still pointer while the list scrolls: those hovers open no card and
  // touch no shared state, so scrolling doesn't redraw the whole window per row passed.
  hoverRow(w, g, hovered, cx) {
    const was = this.hovering;
    if (hovered) this.hovering = w.id;
    else if (this.hovering === w.id) this.hovering = null;
    // Only rows with hover buttons look different when hovered.
    if (was !== this.hovering && (this.isMain(g) || this.hasAgents(w, g))) cx.notify();
    const h = shared(HOVER_KEY) ?? {};
    if (hovered) {
      if (this.card && h.row !== w.id) setShared(HOVER_KEY, { ...h, row: w.id });
      if (this.pointerMoving()) this.scheduleCard(w, cx);
      return;
    }
    this.hoverToken = null;
    if (!this.card) return;
    if (h.row === w.id) setShared(HOVER_KEY, { ...h, row: null });
    cx.timer.after(CARD_CLOSE_MS, () => {
      const now = shared(HOVER_KEY) ?? {};
      if (this.card && !now.card && now.row !== this.card.space) this.closeCard();
    });
  }

  pointerMoving() {
    return Date.now() - (this.pointerAt ?? 0) < 150;
  }

  // The card for the row the pointer rests on, once it has rested CARD_DELAY_MS.
  scheduleCard(w, cx) {
    const token = (this.hoverToken = {});
    cx.timer.after(CARD_DELAY_MS, (cx) => {
      if (this.hoverToken !== token || this.pressed !== null || this.hovering !== w.id) return;
      this.openCard(w);
      this.refreshHovered(w, cx);
    });
  }

  // A row the pointer rests on gets its PR, checks and issue fresh from GitHub (at most every
  // 20s per checkout); the open card follows through shared LIVE_KEY.
  refreshHovered(w, cx) {
    if (!this.settings.pull_request_status) return;
    const folder = spaceFolder(w, panes());
    const started = this.prObserver.refreshNow({ folder, machine: w.machine ?? null }, cx, (entry, ok) => {
      setShared(LIVE_KEY, { space: w.id, prs: (entry?.prs ?? []).map(({ body, ...pr }) => pr), issue: entry?.issue ?? null,
        updated: entry?.updated ?? null, loading: false, failed: !ok });
      // Found something a card can show for a row that had nothing: open it while still hovered.
      if (this.hovering === w.id && !this.card) this.openCard(w);
    });
    if (started) setShared(LIVE_KEY, { space: w.id, loading: true, at: Date.now() });
  }

  openCard(w) {
    const status = this.checkoutStatus(w);
    const prs = status?.prs ?? [], issue = status?.issue ?? null;
    const ports = shared("live-ports")?.bySpace?.[w.id] ?? [];
    const b = this.rowBounds[w.id];
    if ((!prs.length && !issue && !ports.length && !noteOf(w)) || !b) return;
    if (this.card?.space === w.id) return;
    this.closeCard();
    const h = shared(HOVER_KEY) ?? {};
    if (h.row !== w.id) setShared(HOVER_KEY, { ...h, row: w.id });
    // A window, not a popup: it doesn't take the keyboard from the terminal.
    const id = openOverlay({
      mod: "better-sidebar",
      kind: "window",
      width: 340,
      at: { x: b.x + b.width + 8, y: b.y },
      props: {
        view: "card",
        space: w.id,
        folder: spaceFolder(w, panes()),
        machine: w.machine ?? null,
        prs: prs.map(({ body, ...pr }) => pr),
        issue,
        updated: status?.updated ?? null,
      },
    });
    this.card = { id, space: w.id };
  }

  closeCard() {
    if (this.card) closeOverlay(this.card.id);
    this.card = null;
  }

  // Where the dragged space would land.
  dropLine(i, t) {
    return div()
      .absolute()
      .left(0)
      .right(0)
      .h(2)
      .bg(t.accent)
      .when(this.pressed < i, (line) => line.bottom(0))
      .when(this.pressed > i, (line) => line.top(0));
  }

  // Press to select or start a drag; spaces only move within their machine.
  withDragging(row, w, i) {
    return row
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed == null) return;
        const source = spaces()[this.pressed];
        const ok = source && (source.machine ?? null) === (w.machine ?? null);
        const over = ok ? i : null;
        const blocked = ok ? null : (w.machine ?? null);
        if (this.over === over && this.blocked === blocked && !this.target) return;
        this.over = over;
        this.blocked = blocked;
        this.target = null;
        if (i !== this.pressed) this.dragging = true;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        if (from != null && over === i && from !== i) {
          const source = spaces()[from];
          run("space.move", { id: source.id, index: i + 1 });
          // Dropped beside a row, it joins that row's folder (or Unfiled).
          const key = this.unitKey?.[source.id];
          const there = this.unitKey?.[w.id];
          if (key && there && key !== there) {
            const { groups, projects } = readGroups();
            const group = groups.some((g) => g.id === projects[there]) ? projects[there] : null;
            if ((projects[key] ?? null) !== group) fileUnder(key, group);
          }
        } else if (from === i && !this.dragging) run("space.select", { id: w.id });
        this.endDrag();
        cx.notify();
      });
  }

  rowTitle(w, g, tree, t) {
    return h_flex()
      .gap(9)
      .items_center()
      .when(Boolean(tree), (el) => el.pl(22).child(Icon("branch", 13).text_color(t.dim)))
      .when(!tree, (el) => el.child(this.avatar(w, t, g)))
      .child(
        div().flex_1().min_w(0).truncate().tooltip(w.name).text_color(t.foreground).child(shownName(w, g)),
      )
      .when(!tree && Boolean(g) && !g.linked, (el) => el.child(this.repoButtons(w, g, t)))
      .when((Boolean(tree) || !this.isMain(g)) && this.hasAgents(w, g) && (this.hovering === w.id || this.agentsHidden(w, g)), (el) =>
        el.child(this.foldAgentsButton(w, g, t)),
      );
  }

  foldAgentsButton(w, g, t) {
    const hidden = this.agentsHidden(w, g);
    return div()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .child(IconButton({ id: `space-fold-agents-${w.id}`, icon: hidden ? "chevron-right" : "chevron-down",
        label: hidden ? "Show agents" : "Hide agents", iconSize: 13, muted: true, onClick: (cx) => this.toggleAgents(w, g, cx) }).size(22));
  }

  // A repo's row: fold its worktrees, its menu, and a new worktree, shown on hover.
  // A folded repo keeps its chevron visible so its hidden worktrees are findable.
  repoButtons(w, g, t) {
    const kids = this.worktreeCount[g.repo] ?? 0;
    const folded = this.agentsHidden(w, g);
    const agents = this.hasAgents(w, g);
    const hovered = this.hovering === w.id;
    const button = (id, icon, label, onClick) =>
      div()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
        .child(IconButton({ id: `${id}-${w.id}`, icon, label, iconSize: 13, muted: true, onClick }).size(22));
    return h_flex()
      .flex_none()
      .gap(1)
      .items_center()
      .when((kids > 0 || agents) && (hovered || folded), (el) =>
        el.child(
          button("repo-fold", folded ? "chevron-right" : "chevron-down", this.foldLabel(kids, agents, folded), (cx) => this.toggleAgents(w, g, cx)),
        ),
      )
      .when(hovered, (el) =>
        el
          .child(button("repo-menu", "ellipsis", "Space options", () => this.menu(w)))
          .child(
            button("repo-new-worktree", "plus", "New worktree", () =>
              openOverlay({ mod: "new-worktree", kind: "dialog", width: 560, height: 780, props: { space: w.id, folder: spaceFolder(w, panes()) } }),
            ),
          ),
      );
  }

  foldLabel(kids, agents, folded) {
    const what = [kids && `${kids} worktree${kids === 1 ? "" : "s"}`, agents && "agents"].filter(Boolean).join(" and ");
    return folded ? `Show ${what}` : `Hide ${kids && agents ? "worktrees and agents" : kids ? "worktrees" : "agents"}`;
  }

  avatar(w, t, g) {
    // A project's chosen emoji or letter tile wins over the automatic image.
    const own = projectOf(w, g)?.icon;
    if (own?.kind === "emoji" && own.emoji)
      return h_flex().size(18).flex_none().rounded(5).bg((AVATAR_COLORS[own.color] ?? t.raised) + "33").items_center().justify_center()
        .text_size(11).child(own.emoji);
    if (own?.kind === "letter")
      return h_flex().size(18).flex_none().rounded(5).bg(AVATAR_COLORS[own.color] ?? t.accent).items_center().justify_center()
        .text_size(TEXT.avatar).font_bold().text_color("#ffffff").child([...shownName(w, g)][0]?.toUpperCase() ?? "?");
    const icon = g?.repo && (pickedIcon(w.machine, repoRoot(g)) ?? this.repoIcons[g.repo]);
    if (icon) return image(icon).size(18).flex_none().rounded(5);
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (AVATAR_COLORS[color] ?? t[color]);
    return h_flex()
      .size(18)
      .flex_none()
      .rounded(5)
      .bg(fill)
      .items_center()
      .justify_center()
      .text_size(TEXT.avatar)
      .font_bold()
      .text_color("#ffffff")
      .child([...w.name][0]?.toUpperCase() ?? "?");
  }

  compact({ w, i }, t) {
    const badge = this.prBadge(w, t, true);
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(
        div()
          .text_color(w.active ? t.foreground : t.muted)
          .child(String(i + 1)),
      )
      .when(Boolean(badge), (el) => el.child(badge))
      .when(!badge, (el) => el.child(div().text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Share avatar colors with Herdr's own space menus. Do this during data
  // synchronization, never render: setShared itself schedules a redraw.
  updateColors(sp) {
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(
      Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)),
    );
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  render() {
    const t = theme();
    const collapsed = (this.width ?? findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    this.agents.refresh();
    const rows = this.grouped(t, collapsed);
    this.scrollToActive();
    // agent.next / agent.prev follow this list's space order, Agents panel or not.
    setAgentOrder(this.agents.order(this.navOrder()));
    return v_flex()
      .id("better-sidebar-root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .on_size_change((size, cx) => {
        const wasCollapsed = (this.width ?? Infinity) < 160;
        this.width = size.width;
        if (wasCollapsed !== this.width < 160) cx.notify();
      })
      .child(
        h_flex()
          .h(31)
          .pl(16)
          .pr(10)
          .items_center()
          .justify_between()
          .text_size(TEXT.label)
          .text_color(t.dim)
          .when(!collapsed, (el) => el.child("Spaces"))
          .child(
            h_flex()
              .gap(2)
              .items_center()
              // The Agents panel toggle lives in the footer, beside Settings.
              .when(!collapsed, (el) => el.child(this.agentsSwitch(t)))
              .when(!collapsed, (el) =>
                el.child(
                  IconButton({
                    id: "group-new",
                    icon: "folder-plus",
                    label: "New folder",
                    iconSize: 14,
                    muted: true,
                    onClick: () => openNameDialog(null, this.focusedMachine()),
                  }),
                ),
              )
              .child(
                IconButton({
                  id: "space-new",
                  icon: "plus",
                  label: "New space",
                  iconSize: 14,
                  muted: true,
                  onClick: () => this.newSpace(this.focusedMachine()),
                }),
              ),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .id("spaces-list")
          .relative()
          .overflow_hidden()
          .on_size_change((size, cx) => {
            if (size.height === this.viewH) return;
            this.viewH = size.height;
            this.clampScroll();
            cx.notify();
          })
          .on_scroll_wheel((e, cx) => this.scrollBy(-e.delta.y, cx))
          .on_mouse_move((e, cx) => {
            this.pointerAt = Date.now();
            if (this.drag) this.scrollBy(this.drag.from + (e.position.y - this.drag.y) * this.drag.k - this.offset, cx);
          })
          .on_mouse_up("left", (_e, cx) => {
            this.endDrag();
            this.drag = null;
            cx.notify();
          })
          .child(
            v_flex()
              .id("spaces-content")
              .absolute()
              .left(0)
              .right(0)
              .top(-this.offset)
              .px(8)
              .pb(14)
              .on_size_change((size, cx) => {
                if (size.height === this.contentH) return;
                this.contentH = size.height;
                this.clampScroll();
                cx.notify();
              })
              .children(rows),
          )
          .when(this.contentH > this.viewH + 1, (el) => el.child(this.thumb(t))),
      );
  }
}
