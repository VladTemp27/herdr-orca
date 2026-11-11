// The hover card beside a worktree row: its PR, its issue and its live ports,
// and its note, drawn like Herdr's menus. Opened by spaces.js as a window overlay with props
// { view: "card", space, folder, machine, prs, issue }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, shared, setShared, closeOverlay, openOverlay, settings, notify, spaces } from "herdr";
import { prAppearance } from "../git/pr-status.js";
import { TEXT, SIZE, RADIUS, Icon } from "./ui.js";
import { noteOf, openNote } from "./notes.js";

export const HOVER_KEY = "better-sidebar.hover";
// A hovered row's fresh PR and issue (spaces.js refreshHovered): { space, prs?, issue?, loading }.
export const LIVE_KEY = "better-sidebar.card-live";

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const stop = (_e, cx) => cx.stop_propagation();

export class Card {
  init() {}

  // Leaving the card closes it unless the pointer went back to its row.
  hover(hovered, cx) {
    const p = props();
    setShared(HOVER_KEY, { ...(shared(HOVER_KEY) ?? {}), card: hovered });
    if (!hovered) cx.timer.after(250, () => {
      const h = shared(HOVER_KEY) ?? {};
      if (!h.card && h.row !== p.space) closeOverlay(p.overlay);
    });
  }

  view(repo, number, pr) {
    const p = props();
    closeOverlay(p.overlay);
    openOverlay({ mod: "issues", kind: "dialog", width: 0.86, height: 0.9, props: { issue: {
      repo, number, on: null, pr, folder: p.folder, machine: p.machine } } });
  }

  copy(text, cx) {
    cx.write_to_clipboard(text);
    notify({ title: "Link copied", body: text, timeout: 2000 });
  }

  button(id, icon, label, t, onClick) {
    return div().id(id).size(SIZE.iconSmall).flex_none().flex().items_center().justify_center().rounded(RADIUS.control)
      .text_color(t.dim).cursor_pointer().tooltip(label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(Icon(icon, 13));
  }

  label(t, text) {
    return div().px(8).pt(6).pb(3).text_size(TEXT.caption).font_medium().text_color(t.dim).child(text);
  }

  divider(t) {
    return div().h(1).mx(3).my(4).flex_none().bg(t.border);
  }

  // A PR or issue: the row opens it in the viewer; copy and GitHub sit on the right.
  item(t, { id, icon, color, state, title, repo, number, url, pr }) {
    return h_flex().id(id).px(8).py(6).gap(9).items_start().rounded(RADIUS.row).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); this.view(repo, number, pr); })
      .child(div().pt(1).child(Icon(icon, 14).text_color(color)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(TEXT.menu).text_color(t.foreground).child(title))
        .child(h_flex().gap(5).items_center().text_size(TEXT.caption).text_color(t.dim)
          .child(div().flex_none().child(`#${number}`))
          .child(div().flex_none().text_color(color).child(state))
          .child(div().min_w(0).truncate().child(repo))))
      .child(h_flex().flex_none().gap(1)
        .child(this.button(`${id}-copy`, "copy", "Copy link", t, (cx) => this.copy(url, cx)))
        .child(this.button(`${id}-open`, "external", "Open on GitHub", t, (cx) => cx.open_url(url))));
  }

  // The note's lines; a click edits it.
  note(t, space, text) {
    return v_flex().id("card-note").px(8).py(5).gap(1).rounded(RADIUS.row).cursor_pointer().tooltip("Edit note")
      .text_size(TEXT.small).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(props().overlay); openNote(space); })
      .children(text.split("\n").map((line) => div().child(line || " ")));
  }

  port(t, port, mono) {
    // live-ports marks a port on another machine's localhost reachable: false; this computer can't open it.
    const url = port.reachable === false ? null : `http://${port.address}`;
    const where = port.machine ?? "local";
    return h_flex().id(`card-port-${where}-${port.pid}-${port.port}`).h(SIZE.row).flex_none().px(8).gap(9).items_center()
      .rounded(RADIUS.row).tooltip(url ? `Open ${url} · PID ${port.pid}` : `PID ${port.pid} on ${port.machine}`)
      .when(Boolean(url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); }))
      .child(div().size(6).flex_none().rounded(3).bg(t.working))
      .child(div().w(44).flex_none().font_family(mono).text_size(TEXT.small).font_medium().text_color(t.foreground).child(String(port.port)))
      .child(div().flex_none().text_size(TEXT.small).text_color(t.muted).child(port.name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(url || !port.machine ? port.address : `${port.address} on ${port.machine}`));
  }

  render() {
    const p = props(), t = theme(), live = shared(LIVE_KEY);
    // Whichever is newer: the hover refresh's answer for this row, or what the card opened with.
    const mine = live?.space === p.space;
    const src = mine && live.prs && (live.updated ?? 0) >= (p.updated ?? 0) ? live : p;
    const prs = src.prs ?? [], issue = src.issue, refreshing = Boolean(mine && live.loading);
    const failed = Boolean(mine && live.failed), updated = src.updated;
    const ports = shared("live-ports")?.bySpace?.[p.space] ?? [];
    const mono = settings().font_family ?? "JetBrains Mono";
    const sections = [];
    const space = spaces().find((s) => s.id === p.space), note = noteOf(space);
    if (note) sections.push([this.label(t, "Note"), this.note(t, space, note)]);
    if (prs.length) sections.push([this.label(t, prs.length > 1 ? `Pull requests · ${prs.length}` : "Pull request"),
      ...prs.map((pr) => {
        const look = prAppearance(pr, t);
        return this.item(t, { id: `card-pr-${pr.number}`, icon: look.icon, color: look.color, state: look.label, title: pr.title,
          repo: pr.repository, number: pr.number, pr: true, url: pr.url || `https://github.com/${pr.repository}/pull/${pr.number}` });
      })]);
    if (issue) {
      const open = issue.state === "OPEN";
      sections.push([this.label(t, "Issue"), this.item(t, { id: `card-issue-${issue.number}`, icon: open ? "issue" : "issue-closed",
        color: open ? t.ansi2 : t.ansi5, state: open ? "Open" : "Closed", title: issue.title,
        repo: issue.repository, number: issue.number, pr: false, url: issue.url })]);
    }
    if (ports.length) sections.push([this.label(t, `Live ports · ${ports.length}`), ...ports.map((port) => this.port(t, port, mono))]);
    return v_flex().id("space-card").w_full().p(5).gap(1).bg(t.popover).text_color(t.foreground)
      .on_hover((hovered, cx) => this.hover(hovered, cx))
      .children(sections.flatMap((rows, n) => (n ? [this.divider(t), ...rows] : rows)))
      // How fresh this is: refreshing, couldn't refresh, or when GitHub last answered.
      .when(prs.length > 0 || Boolean(issue), (el) => el.child(h_flex().px(8).pt(4).pb(2).gap(6).items_center()
        .text_size(TEXT.caption).text_color(failed ? t.ansi3 : t.dim)
        .when(refreshing, (row) => row.child(Icon("spinner", 11).spin(900)).child("Refreshing from GitHub…"))
        .when(!refreshing && failed, (row) => row.child(`Couldn't reach GitHub${updated ? ` · from ${ago(updated)}` : ""}`))
        .when(!refreshing && !failed && Boolean(updated), (row) => row.child(`Updated ${ago(updated)}`))));
  }
}
