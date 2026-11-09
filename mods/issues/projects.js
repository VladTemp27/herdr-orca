// Projects tab: GitHub Projects (v2) linked to the repo, as a board grouped by a single-select or
// iteration field (Status by default) or a table. Field edits go through gh project item-edit.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { readCache, writeCache, age } from "./cache.js";
import { spaceFor } from "./start.js";
import { openUrl, labelChip } from "./viewer.js";

const LIST_TTL = 30 * 60000;
const FRESH = 2 * 60000;
const PAGES = 5;
const PAGE = 50;
const COLUMN_MAX = 100;
const DAY = 86400000;
const COLORS = { GRAY: "#8b949e", BLUE: "#4493f8", GREEN: "#3fb950", YELLOW: "#d29922", ORANGE: "#db6d28", RED: "#f85149", PINK: "#db61a2", PURPLE: "#a371f7" };
const KINDS = { NUMBER: "number", DATE: "date", TEXT: "text" };
// Item facts that aren't project fields but show beside them; hideable like fields.
const EXTRAS = [{ id: "milestone", name: "Milestone" }, { id: "subissues", name: "Sub-issues progress" }, { id: "parent", name: "Parent issue" }];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LIST_QUERY = `query($o:String!,$n:String!){
  repository(owner:$o,name:$n){ projectsV2(first:20,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ...P } } }
  repositoryOwner(login:$o){ ... on ProjectV2Owner{ projectsV2(first:30,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ...P } } } }
  viewer{ projectsV2(first:30,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ...P } } } }
fragment P on ProjectV2{ id number title url closed owner{ ... on User{ login } ... on Organization{ login } } }`;

const ITEMS_QUERY = `query($id:ID!,$after:String){ node(id:$id){ ... on ProjectV2{ title url
  fields(first:50){ nodes{
    ... on ProjectV2Field{ id name dataType }
    ... on ProjectV2SingleSelectField{ id name options{ id name color } }
    ... on ProjectV2IterationField{ id name configuration{ iterations{ id title startDate duration } completedIterations{ id title startDate duration } } } } }
  items(first:100,after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id isArchived updatedAt
    fieldValues(first:30){ nodes{
      ... on ProjectV2ItemFieldSingleSelectValue{ optionId field{ ... on ProjectV2SingleSelectField{ id } } }
      ... on ProjectV2ItemFieldIterationValue{ iterationId field{ ... on ProjectV2IterationField{ id } } }
      ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{ id } } }
      ... on ProjectV2ItemFieldDateValue{ date field{ ... on ProjectV2Field{ id } } }
      ... on ProjectV2ItemFieldTextValue{ text field{ ... on ProjectV2Field{ id } } } } }
    content{ __typename
      ... on Issue{ number title state stateReason url updatedAt repository{ nameWithOwner } author{ login }
        assignees(first:5){ nodes{ login } } labels(first:6){ nodes{ name color } } milestone{ title }
        parent{ number } subIssuesSummary{ total completed } }
      ... on PullRequest{ number title state isDraft url updatedAt headRefName repository{ nameWithOwner } author{ login }
        assignees(first:5){ nodes{ login } } labels(first:6){ nodes{ name color } } milestone{ title } }
      ... on DraftIssue{ title updatedAt assignees(first:5){ nodes{ login } } } } } } } } }`;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const start = (it) => Date.parse(`${it.startDate}T00:00:00`);
const when = (it) => { const s = start(it), now = Date.now(); return now < s ? "upcoming" : now < s + it.duration * DAY ? "current" : "past"; };
const shortDate = (ms) => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const range = (it) => `${shortDate(start(it))} – ${shortDate(start(it) + (it.duration - 1) * DAY)}`;
const iterHint = (it) => `${range(it)}${when(it) === "current" ? " · Current" : ""}`;

function parseFields(nodes) {
  const out = [];
  for (const f of nodes ?? []) {
    if (!f?.id) continue;
    if (f.options) out.push({ id: f.id, name: f.name, kind: "select", options: f.options.map((o) => ({ id: o.id, name: o.name, color: COLORS[o.color] ?? null })) });
    else if (f.configuration) {
      const c = f.configuration, all = [...c.completedIterations, ...c.iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
      out.push({ id: f.id, name: f.name, kind: "iteration", options: all.map((i) => ({ id: i.id, name: i.title, startDate: i.startDate, duration: i.duration })) });
    } else if (KINDS[f.dataType]) out.push({ id: f.id, name: f.name, kind: KINDS[f.dataType] });
  }
  return out;
}

function normalize(n) {
  const c = n.content ?? {}, values = {};
  for (const v of n.fieldValues?.nodes ?? []) if (v?.field?.id) values[v.field.id] = v.optionId ?? v.iterationId ?? v.number ?? v.date ?? v.text ?? null;
  return {
    id: n.id, type: c.__typename ?? "Hidden", number: c.number ?? null, title: c.title ?? "(no access)",
    state: c.state, stateReason: c.stateReason, isDraft: c.isDraft, url: c.url ?? null, headRefName: c.headRefName,
    updatedAt: c.updatedAt ?? n.updatedAt, repo: c.repository?.nameWithOwner ?? null, author: c.author,
    assignees: c.assignees?.nodes ?? [], labels: c.labels?.nodes ?? [], values,
    milestone: c.milestone?.title ?? null, parent: c.parent?.number ?? null, subIssues: c.subIssuesSummary?.total ? c.subIssuesSummary : null,
  };
}

// gh exits 1 on GraphQL errors and prints them as JSON; the missing-scope one gets a fix.
function ghError(r) {
  const text = (r.stderr || r.stdout || "").trim();
  if (/INSUFFICIENT_SCOPES|read:project/i.test(text)) return "gh needs the project scope: run  gh auth refresh -s project";
  try { return JSON.parse(r.stdout).errors?.map((e) => e.message).join("; ") || text; } catch { return text; }
}

async function graphql(query, vars, on) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push("-f", `${k}=${v}`);
  const r = await exec("gh", args, { on });
  if (r.code !== 0) throw new Error(ghError(r));
  return JSON.parse(r.stdout).data;
}

// Query tokens: key:value, key:a,"b c" (any of), -key:value (not), "quoted words", words.
const VALUE = /"[^"]*"|[^\s",]+/g;
export const tokens = (q) => q.match(/-?[\w-]+:(?:"[^"]*"|[^\s",]+)(?:,(?:"[^"]*"|[^\s",]+))*|"[^"]*"|\S+/g) ?? [];
const unquote = (s) => s.replace(/^"|"$/g, "");
const quote = (v) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
function split(token) {
  const m = /^(-?)([\w-]+):(.+)$/.exec(token);
  return m ? { neg: Boolean(m[1]), key: m[2].toLowerCase(), values: (m[3].match(VALUE) ?? []).map(unquote) } : null;
}
const sameKey = (s, key) => s && !s.neg && norm(s.key) === norm(key);

// The values a key is filtered to, lowercased.
export function active(q, key) {
  const out = new Set();
  for (const t of tokens(q)) { const s = split(t); if (sameKey(s, key)) for (const v of s.values) out.add(v.toLowerCase()); }
  return out;
}

// Adds or removes one value of key, keeping one key:a,b token per key.
export function toggleValue(q, key, value) {
  const ts = tokens(q), v = value.toLowerCase(), at = ts.findIndex((t) => sameKey(split(t), key));
  if (at < 0) return [...ts, `${key}:${quote(value)}`].join(" ");
  const s = split(ts[at]), has = s.values.some((x) => x.toLowerCase() === v);
  const values = has ? s.values.filter((x) => x.toLowerCase() !== v) : [...s.values, value];
  if (values.length) ts[at] = `${key}:${values.map(quote).join(",")}`; else ts.splice(at, 1);
  return ts.join(" ");
}

export const toggleToken = (q, token) => { const ts = tokens(q); return (ts.includes(token) ? ts.filter((t) => t !== token) : [...ts, token]).join(" "); };

// One value of one key; undefined when the key means nothing here (then it doesn't filter).
function matchOne(i, k, v, me, fields) {
  const field = (name) => fields.find((f) => norm(f.name) === norm(name)) ?? (norm(name) === "iteration" ? fields.find((f) => f.kind === "iteration") : null);
  if (k === "assignee") return i.assignees.some((a) => a.login.toLowerCase() === (v === "@me" ? me?.toLowerCase() : v));
  if (k === "label") return i.labels.some((l) => l.name.toLowerCase() === v);
  if (k === "repo") return (i.repo ?? "").toLowerCase().includes(v);
  if (k === "milestone") return (i.milestone ?? "").toLowerCase() === v;
  if (k === "no") {
    if (v === "assignee") return !i.assignees.length;
    if (v === "label") return !i.labels.length;
    if (v === "milestone") return !i.milestone;
    const f = field(v);
    return f ? i.values[f.id] == null : undefined;
  }
  if (k === "is") return { open: i.state === "OPEN", closed: i.state === "CLOSED" || i.state === "MERGED", merged: i.state === "MERGED",
    draft: i.type === "DraftIssue", issue: i.type === "Issue", pr: i.type === "PullRequest" }[v];
  if (k === "type") return { issue: i.type === "Issue", pr: i.type === "PullRequest", draft: i.type === "DraftIssue" }[v];
  const f = field(k), val = f ? i.values[f.id] : null;
  if (!f) return undefined;
  if (f.kind === "select") return f.options.find((o) => o.id === val)?.name.toLowerCase() === v;
  if (f.kind === "iteration") {
    const it = f.options.find((o) => o.id === val);
    if (!it) return false;
    if (v === "@current") return when(it) === "current";
    if (v === "@next") return it.id === f.options.find((o) => when(o) === "upcoming")?.id;
    if (v === "@previous") return it.id === f.options.filter((o) => when(o) === "past").at(-1)?.id;
    return it.name.toLowerCase() === v;
  }
  return val != null && String(val).toLowerCase() === v;
}

function matches(i, token, me, fields) {
  const s = split(token);
  if (!s) return `${i.title} #${i.number ?? ""} ${i.repo ?? ""}`.toLowerCase().includes(unquote(token).toLowerCase());
  const hits = s.values.map((v) => matchOne(i, s.key, v.toLowerCase(), me, fields));
  if (hits.some((x) => x === undefined)) return true;
  return s.neg ? !hits.some(Boolean) : hits.some(Boolean);
}

// The filter popup (its own overlay copy): stays open, checks follow shared "issues.projectQuery".
export function filterMenuView(host, t) {
  const { sections, q: first, overlay } = host.filterMenu, q = shared("issues.projectQuery") ?? first, ts = tokens(q);
  const on = (r) => (r.token ? ts.includes(r.token) : active(q, r.key).has(r.value.toLowerCase()));
  const send = (v) => setShared("issues.pick", { ...v, at: Date.now() });
  const link = (id, label, onClick) => div().id(id).h(26).px(8).flex().items_center().rounded(6).cursor_pointer().text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  return v_flex().id("filter-menu").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
    .child(h_flex().h(40).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().font_semibold().child(ts.length ? `Filter · ${ts.length}` : "Filter"))
      .when(ts.length > 0, (e) => e.child(link("filter-clear", "Clear", () => send({ clearFilter: true }))))
      .child(link("filter-done", "Done", () => closeOverlay(overlay))))
    .child(v_flex().id("filter-list").h(440).flex_none().overflow_y_scrollbar().p(6).gap(1)
      .children(sections.flatMap((s, k) => [
        div().px(8).pt(8).pb(3).text_size(11).font_semibold().text_color(t.dim).child(s.title),
        ...s.rows.map((r, n) => h_flex().id(`f-${k}-${n}`).min_h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_click(() => send({ toggleFilter: r.token ? { token: r.token } : { key: r.key, value: r.value } }))
          .child(div().w(14).flex_none().text_color(t.accent).child(on(r) ? "✓" : ""))
          .when(Boolean(r.color), (e) => e.child(div().size(10).flex_none().rounded(5).bg(r.color)))
          .child(div().flex_1().min_w(0).truncate().child(r.label))
          .when(Boolean(r.hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(r.hint))))])));
}

export class Projects {
  constructor(host) {
    this.host = host; this.data = {}; this.loading = null; this.error = null; this.menuAt = null;
    this.view = shared("issues.projectView") ?? "board";
  }

  list(repo = this.host.repo) { return (shared("issues.projectLists") ?? {})[repo] ?? null; }

  // The project picked for this repo, else its first linked one.
  current() {
    const repo = this.host.repo;
    return (shared("issues.projectFor") ?? {})[repo] ?? this.list(repo)?.linked?.[0] ?? null;
  }

  groupable(entry) { return (entry?.fields ?? []).filter((f) => f.kind === "select" || f.kind === "iteration"); }

  field(entry) {
    const pick = (shared("issues.groupBy") ?? {})[this.current()?.id], g = this.groupable(entry);
    return g.find((f) => f.id === pick) ?? g.find((f) => f.name === "Status") ?? g[0] ?? null;
  }

  hidden() { return new Set((shared("issues.hiddenFields") ?? {})[this.current()?.id] ?? []); }

  // ---- data ----

  async fetchList(repo, on) {
    const [o, n] = repo.split("/");
    const d = await graphql(LIST_QUERY, { o, n }, on);
    const open = (nodes) => (nodes ?? []).filter((p) => p && !p.closed);
    const linked = open(d.repository?.projectsV2?.nodes), seen = new Set(linked.map((p) => p.id));
    const other = [...open(d.repositoryOwner?.projectsV2?.nodes), ...open(d.viewer?.projectsV2?.nodes)].filter((p) => !seen.has(p.id) && seen.add(p.id));
    const entry = { at: Date.now(), linked, other };
    setShared("issues.projectLists", { ...(shared("issues.projectLists") ?? {}), [repo]: entry });
    return entry;
  }

  async fetchItems(id, on) {
    let after = null, head = null;
    const items = [];
    for (let k = 0; k < PAGES; k++) {
      const node = (await graphql(ITEMS_QUERY, { id, after }, on))?.node;
      if (!node) throw new Error("Project not found, or gh can't see it");
      head ??= { title: node.title, url: node.url, fields: parseFields(node.fields.nodes) };
      items.push(...node.items.nodes.filter((n) => !n.isArchived).map(normalize));
      if (!node.items.pageInfo.hasNextPage) break;
      after = node.items.pageInfo.endCursor;
    }
    return { at: Date.now(), ...head, items };
  }

  // The project list (30 min), then the picked project's items: disk cache at once, GitHub after FRESH.
  load(cx, force = false) {
    const h = this.host, repo = h.repo, on = h.repoOn;
    if (!repo) return;
    const listed = this.list(repo), p = this.current(), held = p ? this.data[p.id] : null;
    if (!force && age(listed) < LIST_TTL && p && age(held) < FRESH) return;
    const key = `${repo}|${p?.id}`;
    if (this.loading?.key === key && Date.now() - this.loading.at < 60000) return;
    const loading = (this.loading = { key, at: Date.now() });
    this.error = null;
    cx.spawn(async (cx) => {
      cx.notify();
      try {
        if (force || age(listed) >= LIST_TTL) { await this.fetchList(repo, on); cx.notify(); }
        const project = this.current();
        if (!project || h.repo !== repo) return;
        const cacheKey = `project2:${project.id}`;
        let entry = this.data[project.id] ?? (await readCache(cacheKey));
        if (entry && !this.data[project.id]) { this.data[project.id] = entry; cx.notify(); }
        if (!force && age(entry) < FRESH) return;
        entry = await this.fetchItems(project.id, on);
        this.data[project.id] = entry; writeCache(cacheKey, entry);
      } catch (e) { if (h.repo === repo) this.error = String(e?.message ?? e); }
      finally { if (this.loading === loading) this.loading = null; cx.notify(); }
    });
  }

  // Shown at once; the cache keeps the new value, a failure reloads the truth.
  setField(m, cx) {
    const entry = this.data[m.project], item = entry?.items.find((i) => i.id === m.item);
    if (item) item.values = { ...item.values, [m.field]: m.value };
    cx.notify();
    cx.spawn(async (cx) => {
      const args = ["project", "item-edit", "--id", m.item, "--project-id", m.project, "--field-id", m.field,
        ...(m.value == null ? ["--clear"] : m.kind === "iteration" ? ["--iteration-id", m.value] : ["--single-select-option-id", m.value])];
      const r = await exec("gh", args, { on: this.host.repoOn }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) { if (entry) writeCache(`project2:${m.project}`, entry); return; }
      this.error = ghError(r);
      this.load(cx, true);
    });
  }

  handle(p, cx) {
    const h = this.host, pid = this.current()?.id;
    if (p.project) {
      setShared("issues.projectFor", { ...(shared("issues.projectFor") ?? {}), [h.repo]: p.project });
      h.page = 0; return this.load(cx);
    }
    if (p.groupBy) { setShared("issues.groupBy", { ...(shared("issues.groupBy") ?? {}), [p.groupBy.project]: p.groupBy.field }); return cx.notify(); }
    if (p.toggleField) {
      const all = shared("issues.hiddenFields") ?? {}, now = new Set(all[pid] ?? []);
      now.has(p.toggleField) ? now.delete(p.toggleField) : now.add(p.toggleField);
      setShared("issues.hiddenFields", { ...all, [pid]: [...now] });
      return cx.notify();
    }
    if (p.projectsRefresh) return this.load(cx, true);
    if (p.toggleFilter) {
      const q = h.query.projects ?? "", f = p.toggleFilter;
      return h.apply(f.token ? toggleToken(q, f.token) : toggleValue(q, f.key, f.value), cx);
    }
    if (p.clearFilter) return h.apply("", cx);
    if (p.setField) return this.setField(p.setField, cx);
    if (p.fieldMenu) {
      const entry = this.data[pid], i = entry?.items.find((x) => x.id === p.fieldMenu.item), f = entry?.fields.find((x) => x.id === p.fieldMenu.field);
      if (i && f) this.fieldMenu(i, f, this.menuAt);
    }
  }

  setView(view, cx) { this.view = view; setShared("issues.projectView", view); this.host.page = 0; cx.notify(); }

  // ---- popups ----

  pickProject() {
    const h = this.host, l = this.list(), cur = this.current(), name = h.repo.split("/")[1];
    const row = (p) => ({ label: p.title, hint: `${p.owner?.login ?? ""} · #${p.number}`, check: p.id === cur?.id, pick: p.id === cur?.id ? null : { project: p } });
    h.popup({ title: "Project", items: [
      { heading: l?.linked?.length ? `LINKED TO ${name.toUpperCase()}` : `NOTHING LINKED TO ${name.toUpperCase()}` },
      ...(l?.linked ?? []).map(row),
      ...(l?.other?.length ? [{ heading: "OTHER PROJECTS" }, ...l.other.map(row)] : []),
      { label: "Refresh list", pick: { projectsRefresh: true } },
    ] }, 340);
  }

  pickGroup(entry) {
    const f = this.field(entry), id = this.current()?.id;
    this.host.popup({ title: "Group by", items: this.groupable(entry).map((x) => ({ label: x.name, hint: x.kind === "iteration" ? "Iteration" : undefined,
      check: x.id === f?.id, pick: x.id === f?.id ? null : { groupBy: { project: id, field: x.id } } })) });
  }

  pickFields(entry) {
    const hidden = this.hidden(), group = this.field(entry);
    const rows = [...entry.fields.filter((f) => f.id !== group?.id), ...EXTRAS];
    this.host.popup({ title: "Show on cards", items: rows.map((f) => ({ label: f.name, check: !hidden.has(f.id), pick: { toggleField: f.id } })) }, 260);
  }

  // Sections built from the project's fields and what its items hold (people, labels, milestones, repos).
  openFilter(entry) {
    const h = this.host, items = entry.items, sections = [], by = (a, b) => a.label.localeCompare(b.label);
    const distinct = (list) => [...new Map(list.map((r) => [r.value.toLowerCase(), r])).values()].sort(by);
    for (const f of entry.fields) {
      const key = norm(f.name), none = { label: `No ${f.name}`, token: `no:${key}` };
      if (f.kind === "iteration") sections.push({ title: f.name.toUpperCase(), rows: [
        { label: `Current ${f.name.toLowerCase()}`, key, value: "@current" },
        { label: `Next ${f.name.toLowerCase()}`, key, value: "@next" },
        { label: `Previous ${f.name.toLowerCase()}`, key, value: "@previous" },
        ...f.options.filter((o) => when(o) !== "past" || items.some((i) => i.values[f.id] === o.id)).map((o) => ({ label: o.name, hint: iterHint(o), key, value: o.name })),
        none] });
      if (f.kind === "select") sections.push({ title: f.name.toUpperCase(), rows: [...f.options.map((o) => ({ label: o.name, color: o.color, key, value: o.name })), none] });
    }
    const people = distinct(items.flatMap((i) => i.assignees.map((a) => ({ label: a.login, key: "assignee", value: a.login }))));
    sections.push({ title: "ASSIGNEE", rows: [{ label: "Me", hint: h.me ?? "", key: "assignee", value: "@me" }, ...people, { label: "No assignee", token: "no:assignee" }] });
    const labels = distinct(items.flatMap((i) => i.labels.map((l) => ({ label: l.name, key: "label", value: l.name, color: /^[0-9a-f]{6}$/i.test(l.color ?? "") ? `#${l.color}` : null }))));
    if (labels.length) sections.push({ title: "LABEL", rows: [...labels, { label: "No label", token: "no:label" }] });
    const milestones = distinct(items.filter((i) => i.milestone).map((i) => ({ label: i.milestone, key: "milestone", value: i.milestone })));
    if (milestones.length) sections.push({ title: "MILESTONE", rows: [...milestones, { label: "No milestone", token: "no:milestone" }] });
    const repos = distinct(items.filter((i) => i.repo).map((i) => ({ label: i.repo.split("/")[1], hint: i.repo.split("/")[0], key: "repo", value: i.repo })));
    if (repos.length > 1) sections.push({ title: "REPOSITORY", rows: repos });
    sections.push({ title: "TYPE", rows: [["Issues", "issue"], ["Pull requests", "pr"], ["Drafts", "draft"]].map(([label, value]) => ({ label, key: "type", value })) });
    sections.push({ title: "STATE", rows: [["Open", "open"], ["Closed", "closed"], ["Merged", "merged"]].map(([label, value]) => ({ label, key: "is", value })) });
    setShared("issues.projectQuery", h.query.projects ?? "");
    const at = h.anchor();
    openOverlay({ mod: "issues", kind: "popup", width: 320, height: 480, ...(at ? { at } : {}), props: { filterMenu: { sections, q: h.query.projects ?? "" } } });
  }

  // Options a select or iteration can be set to; past iterations only when already chosen.
  options(f, now) { return f.kind === "iteration" ? f.options.filter((o) => when(o) !== "past" || o.id === now) : f.options; }

  setPick(i, f, value) { return { setField: { project: this.current()?.id, item: i.id, field: f.id, kind: f.kind, value } }; }

  fieldMenu(i, f, at) {
    const now = i.values[f.id] ?? null;
    this.host.popup({ title: f.name, items: [
      ...this.options(f, now).map((o) => ({ label: o.name, hint: f.kind === "iteration" ? iterHint(o) : undefined, check: now === o.id, pick: now === o.id ? null : this.setPick(i, f, o.id) })),
      ...(now ? [{ label: `Clear ${f.name}`, pick: this.setPick(i, f, null) }] : []),
    ] }, 260, at);
  }

  // The card's ⋯ menu: the group field's options, then the other editable fields.
  itemMenu(i, f, entry) {
    const at = (this.menuAt = this.host.anchor()), now = f ? i.values[f.id] ?? null : null;
    const others = this.groupable(entry).filter((x) => x.id !== f?.id);
    this.host.popup({ title: f ? `Move to (${f.name})` : undefined, items: [
      ...(f ? this.options(f, now).map((o) => ({ label: o.name, hint: f.kind === "iteration" ? iterHint(o) : undefined, check: now === o.id, pick: now === o.id ? null : this.setPick(i, f, o.id) })) : []),
      ...(f && now ? [{ label: `Clear ${f.name}`, pick: this.setPick(i, f, null) }] : []),
      ...(others.length ? [{ heading: "SET" }, ...others.map((x) => ({ label: `${x.name}…`, pick: { fieldMenu: { item: i.id, field: x.id } } }))] : []),
      ...(i.url ? [{ heading: "" }, { label: "Open on GitHub", open: i.url }] : []),
    ] }, 260, at);
  }

  // ---- render ----

  columns(items, f) {
    if (!f) return [{ id: null, name: "Items", items }];
    const by = new Map([[null, []], ...f.options.map((o) => [o.id, []])]);
    for (const i of items) (by.get(i.values[f.id] ?? null) ?? by.get(null)).push(i);
    const iter = f.kind === "iteration";
    return [{ id: null, name: `No ${f.name}`, items: by.get(null) },
      ...f.options.map((o) => ({ id: o.id, name: o.name, color: o.color ?? null, items: by.get(o.id),
        hint: iter ? iterHint(o) : null, current: iter && when(o) === "current", past: iter && when(o) === "past" }))]
      .filter((c) => (c.id !== null && !c.past) || c.items.length);
  }

  itemState(i, t) {
    if (i.type === "DraftIssue") return { label: "Draft", color: t.muted, glyph: "draft" };
    if (i.type === "Hidden") return { label: "Hidden", color: t.dim, glyph: "skipped" };
    return this.host.status(i, t, i.type === "PullRequest");
  }

  open(i) {
    if (i.number && i.repo) this.host.openIssue(i, { repo: i.repo, pr: i.type === "PullRequest" });
    else if (this.current()?.url) openUrl(this.current().url);
  }

  startBtn(i, t, h) {
    if (!i.number || !i.repo) return div();
    const pr = i.type === "PullRequest", space = spaceFor(i, pr);
    return this.host.btn(`pstart-${i.id}`, t, [div().font_medium().child(space ? "Open" : "Start"), this.host.glyph("arrow", 13)],
      (cx) => this.host.start(i, cx, { repo: i.repo, pr }), { solid: Boolean(space), h });
  }

  // A small field chip; color tints it like GitHub, onClick makes it an editor.
  tag(id, t, { text, color = null, glyph = null, onClick = null }) {
    const h = this.host, c = color ?? t.muted;
    return h_flex().id(id).h(20).max_w(220).px(7).gap(4).flex_none().items_center().rounded(10).border_1()
      .border_color(color ? c + "80" : t.border).when(Boolean(color), (e) => e.bg(c + "1f")).text_size(11).text_color(c)
      .when(Boolean(glyph), (e) => e.child(h.glyph(glyph, 11, c)))
      .child(div().truncate().child(text))
      .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (ev, cx) => { h.press = ev; cx.stop_propagation(); })
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }));
  }

  // Labels, then every shown field with a value (not the one grouped by), then the extras.
  chips(i, group, entry, t) {
    const hidden = this.hidden(), out = i.labels.map((l) => labelChip(l, t));
    for (const f of entry.fields) {
      const v = i.values[f.id], key = `${i.id}-${f.id}`;
      if (v == null || f.id === group?.id || hidden.has(f.id)) continue;
      const edit = () => this.fieldMenu(i, f, this.host.anchor());
      if (f.kind === "select") {
        const o = f.options.find((x) => x.id === v);
        if (o) out.push(this.tag(key, t, { text: o.name, color: o.color ?? t.muted, onClick: edit }));
      } else if (f.kind === "iteration") {
        const o = f.options.find((x) => x.id === v);
        if (o) out.push(this.tag(key, t, { text: o.name, glyph: "calendar", color: when(o) === "current" ? t.accent : null, onClick: edit }));
      } else if (f.kind === "date") out.push(this.tag(key, t, { text: `${f.name}: ${shortDate(Date.parse(`${v}T00:00:00`))}`, glyph: "calendar" }));
      else out.push(this.tag(key, t, { text: `${f.name}: ${v}` }));
    }
    if (i.milestone && !hidden.has("milestone")) out.push(this.tag(`${i.id}-ms`, t, { text: i.milestone, glyph: "milestone" }));
    if (i.subIssues && !hidden.has("subissues")) out.push(this.tag(`${i.id}-sub`, t, { text: `${i.subIssues.completed}/${i.subIssues.total}`, glyph: "done",
      color: i.subIssues.completed === i.subIssues.total ? "#3fb950" : null }));
    if (i.parent && !hidden.has("parent")) out.push(this.tag(`${i.id}-parent`, t, { text: `Parent #${i.parent}`, glyph: "issue" }));
    return out;
  }

  card(t, cx) {
    const h = this.host, p = this.current(), entry = p ? this.data[p.id] : null, f = this.field(entry);
    const q = h.query.projects ?? "", count = tokens(q).length;
    const iter = entry?.fields.find((x) => x.kind === "iteration"), iterKey = iter ? norm(iter.name) : null;
    const busy = Boolean(this.loading);
    const shell = v_flex().flex_1().min_h(0).rounded(12).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(h_flex().px(18).pt(14).gap(8).items_center()
        .child(h.chip("view-board", "Board", this.view === "board", t, (cx) => this.setView("board", cx)))
        .child(h.chip("view-table", "Table", this.view === "table", t, (cx) => this.setView("table", cx)))
        .child(div().w(1).h(20).mx(4).bg(t.border))
        .child(h.chip("seg-all-items", "All items", !q.trim(), t, (cx) => h.apply("", cx)))
        .child(h.chip("seg-mine-items", "Assigned to me", active(q, "assignee").has("@me"), t, (cx) => h.apply(toggleValue(q, "assignee", "@me"), cx)))
        .when(Boolean(iter), (e) => e.child(h.chip("seg-current", `Current ${iter.name.toLowerCase()}`, active(q, iterKey).has("@current"), t,
          (cx) => h.apply(toggleValue(q, iterKey, "@current"), cx)))))
      .child(h_flex().px(18).py(12).gap(8).items_center()
        .child(h.btn("project-pick", t, [h.glyph("board", 15, t.muted), div().max_w(240).truncate().child(p?.title ?? "Choose project"), h.glyph("updown", 14, t.muted)], () => this.pickProject()))
        .when(Boolean(f), (e) => e.child(h.btn("group-by", t, [div().text_color(t.muted).child("Group by"), div().child(f.name), h.glyph("chevron", 12, t.muted)], () => this.pickGroup(entry))))
        .when(Boolean(entry), (e) => e
          .child(h.btn("filter", t, [h.glyph("filter", 15), div().child("Filter"),
            ...(count ? [div().h(18).px(6).flex().items_center().rounded(9).bg(t.foreground).text_color(t.background).text_size(11).font_semibold().child(String(count))] : [])],
            () => this.openFilter(entry)))
          .child(h.btn("fields", t, [h.glyph("table", 15), div().child("Fields")], () => this.pickFields(entry))))
        .child(h.searchBox(t, q, ""))
        .when(Boolean(p?.url), (e) => e.child(h.btn("project-github", t, h.glyph("external", 16), () => openUrl(p.url), { square: true })))
        .child(h.btn("project-refresh", t, busy ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.working).spin(900) : h.glyph("refresh", 16),
          (cx) => this.load(cx, true), { square: true })))
      .when(Boolean(this.error), (e) => e.child(div().px(18).pb(8).text_size(12).text_color(t.ansi1).child(this.error)));

    if (!p) return shell.child(this.notice(t, this.list() ? `No project is linked to ${h.repo}` : "Looking for projects…",
      this.list() ? "Choose one of your projects above, or link one on GitHub from the repo's Projects tab." : ""));
    if (!entry) return shell.child(this.notice(t, busy ? "Loading project…" : "Project not loaded", ""));
    const ts = tokens(q.trim());
    const items = ts.length ? entry.items.filter((i) => ts.every((tk) => matches(i, tk, h.me, entry.fields))) : entry.items;
    const cols = this.columns(items, f);
    return shell.child(this.view === "table" ? this.table(cols, f, entry, t, cx) : this.board(cols, f, entry, t, cx));
  }

  notice(t, title, hint) {
    return v_flex().flex_1().items_center().justify_center().gap(8).border_t(1).border_color(t.border).bg(t.background)
      .child(this.host.glyph("board", 26, t.dim))
      .child(div().font_semibold().text_color(t.muted).child(title))
      .when(Boolean(hint), (e) => e.child(div().text_size(12).text_color(t.dim).child(hint)));
  }

  board(cols, f, entry, t, cx) {
    return h_flex().id(`board-${this.current().id}`).flex_1().min_h(0).overflow_x_scrollbar().px(18).pb(16).gap(12)
      .children(cols.map((c) => {
        const color = c.color ?? (c.current ? t.accent : t.muted), shown = c.items.slice(0, COLUMN_MAX);
        return v_flex().w(300).flex_none().h_full().min_h(0).rounded(10).border_1().border_color(c.current ? t.accent + "80" : t.border).bg(t.background)
          .child(h_flex().min_h(42).py(6).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
            .child(div().size(10).flex_none().rounded(5).border_1().border_color(color).bg(color + "40"))
            .child(v_flex().min_w(0)
              .child(div().font_semibold().truncate().child(c.name))
              .when(Boolean(c.hint), (e) => e.child(div().text_size(11).text_color(c.current ? t.accent : t.muted).child(c.hint))))
            .child(div().h(20).px(7).flex_none().flex().items_center().rounded(10).bg(t.raised).text_size(11).text_color(t.muted).child(String(c.items.length))))
          .child(v_flex().id(`col-${c.id ?? "none"}`).flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8)
            .children(shown.map((i) => this.boardCard(i, f, entry, t, cx)))
            .when(!c.items.length, (e) => e.child(div().py(16).text_center().text_size(12).text_color(t.dim).child("Empty")))
            .when(c.items.length > COLUMN_MAX, (e) => e.child(div().py(8).text_center().text_size(12).text_color(t.dim)
              .child(`${c.items.length - COLUMN_MAX} more: filter to narrow`))));
      }));
  }

  boardCard(i, f, entry, t, cx) {
    const h = this.host, s = this.itemState(i, t), chips = this.chips(i, f, entry, t);
    return v_flex().id(`card-${i.id}`).flex_none().p(10).gap(7).rounded(8).border_1().border_color(t.border).bg(t.chrome)
      .cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.open(i))
      .child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(h.glyph(s.glyph, 13, s.color))
        .child(div().flex_1().min_w(0).truncate().child(i.number ? `${i.repo?.split("/")[1] ?? ""} #${i.number}` : s.label))
        .child(div().id(`cmove-${i.id}`).size(24).flex().items_center().justify_center().rounded(6)
          .hover((st) => st.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", (e, cx) => { h.press = e; cx.stop_propagation(); })
          .on_click((_e, cx) => { cx.stop_propagation(); this.itemMenu(i, f, entry); })
          .child(h.glyph("dots", 15))))
      .child(div().text_size(13).child(i.title))
      .when(chips.length > 0, (e) => e.child(h_flex().gap(5).flex_wrap().children(chips)))
      .child(h_flex().gap(4).items_center()
        .children(i.assignees.slice(0, 3).map((a) => h.avatar(a.login, 20, t, cx)))
        .child(div().flex_1())
        .child(this.startBtn(i, t, 26)));
  }

  table(cols, f, entry, t, cx) {
    const h = this.host, rows = cols.flatMap((c) => c.items.map((i) => [i, c]));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (h.page >= pages) h.page = pages - 1;
    const shown = rows.slice(h.page * PAGE, (h.page + 1) * PAGE);
    const cell = (w, child) => h_flex().w(w).flex_none().items_center().child(child);
    const label = (s) => div().text_size(11).font_semibold().text_color(t.dim).child(s);
    const line = () => h_flex().px(18).gap(12).items_center().border_b(1).border_color(t.border);
    return v_flex().flex_1().min_h(0)
      .child(line().h(40).border_t(1).bg(t.chrome)
        .child(cell(96, label("ID"))).child(div().flex_1().child(label("TITLE / FIELDS")))
        .child(cell(150, label((f?.name ?? "Status").toUpperCase()))).child(cell(110, label("ASSIGNEES")))
        .child(cell(120, label("UPDATED"))).child(cell(100, div())))
      .child(v_flex().id(`prows-${h.page}`).flex_1().min_h(0).overflow_y_scrollbar()
        .children(shown.map(([i, c]) => {
          const s = this.itemState(i, t), color = c.color ?? (c.current ? t.accent : t.muted);
          return line().id(`prow-${i.id}`).min_h(64).py(8).bg(t.background).cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.open(i))
            .child(cell(96, h_flex().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
              .child(h.glyph(s.glyph, 13, s.color)).child(i.number ? `#${i.number}` : s.label)))
            .child(v_flex().flex_1().min_w(0).gap(4)
              .child(div().text_size(14).truncate().child(i.title))
              .child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted).overflow_hidden()
                .when(Boolean(i.author?.login), (e) => e.child(div().flex_none().child(i.author.login.replace(/^app\//, ""))))
                .when(Boolean(i.repo), (e) => e.child(div().flex_none().child(i.repo.split("/")[1])))
                .children(this.chips(i, f, entry, t))))
            .child(cell(150, f
              ? h_flex().id(`pmove-${i.id}`).h(26).max_w(150).px(8).gap(5).items_center().rounded(13).border_1().border_color(color + "99").bg(color + "1a")
                .text_size(12).text_color(color).on_mouse_down("left", (e, cx) => { h.press = e; cx.stop_propagation(); })
                .on_click((_e, cx) => { cx.stop_propagation(); this.itemMenu(i, f, entry); })
                .child(div().truncate().child(c.id ? c.name : "None")).child(h.glyph("chevron", 11, color))
              : div()))
            .child(cell(110, h_flex().gap(4).children(i.assignees.slice(0, 3).map((a) => h.avatar(a.login, 22, t, cx)))
              .when(!i.assignees.length, (e) => e.child(div().text_color(t.dim).child("–")))))
            .child(cell(120, div().text_size(12).text_color(t.muted).child(h.updated(i.updatedAt))))
            .child(cell(100, h_flex().w_full().justify_end().child(this.startBtn(i, t, 30))));
        }))
        .when(!shown.length, (e) => e.child(div().py(40).text_center().text_size(12).text_color(t.dim).child("No items match"))))
      .when(pages > 1, (e) => e.child(h.pager(pages, t)));
  }
}
