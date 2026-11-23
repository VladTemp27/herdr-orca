// The right-click popup. Opened by panel.js with
// props { role: "menu", path (absolute), dir, on, panel, items (indexes into ITEMS), overlay }.
// ↑/↓ move, Enter runs, Esc closes.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, setShared, theme, exec, notify } from "herdr";
import { ITEMS, argvOf, NEW_FILE } from "./items.js";

// A plain class: main.js (the View) owns it and forwards init and render.
export default class Menu {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  list() {
    return (props()?.items ?? []).map(i => ITEMS[i]).filter(Boolean);
  }

  choose(i) {
    const p = props(), it = this.list()[i];
    if (!it) return;
    closeOverlay(p.overlay);
    // The panel that opened the menu types the name inline: in the clicked folder, or beside the clicked file.
    if (it.action === "new-file") {
      const folder = p.dir ? p.path : p.path.slice(0, p.path.lastIndexOf("/")) || "/";
      return setShared(NEW_FILE, { panel: p.panel, folder, at: Date.now() });
    }
    const [cmd, ...args] = argvOf(it, p.path);
    // Not awaited by the menu: Quick Look runs until its window is closed.
    exec(cmd, args).then(
      r => { if (r.code !== 0 && cmd !== "qlmanage") notify({ title: it.label, body: r.stderr.trim() || `Exited with ${r.code}`, level: "error" }); },
      e => notify({ title: it.label, body: String(e), level: "error" }),
    );
  }

  render(cx) {
    const t = theme(), p = props(), list = this.list();
    return v_flex()
      .id("files-open-with-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (!list.length) return;
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .child(div().h(26).px(8).pt(4).text_size(11).text_color(t.dim).truncate().child(p?.path?.split("/").pop() || p?.path || ""))
      .children(list.map((it, i) =>
        h_flex()
          .id(`fow-${i}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click(() => this.choose(i))
          .child(svg(`mods/files-open-with/menu-${it.icon}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().truncate().child(it.label))));
  }
}
