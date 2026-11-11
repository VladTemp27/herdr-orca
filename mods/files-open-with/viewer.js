// A file in its own tab, opened by panel.js with props { role: "viewer", file (absolute), on }.
// Markdown renders formatted (Source toggles to text); other files show as read-only code.
import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, watchFolder, theme, settings, focused, spaces, window } from "herdr";
import { openFile } from "./tabs.js";
import { syntaxColors, languageFor } from "./syntax.js";

const LIMIT = 400000;
const isMarkdown = path => /\.(md|markdown|mdx)$/i.test(path ?? "");
const windows = on => !on && window()?.platform === "windows";
const dirname = (path, on) => path.slice(0, windows(on) ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/")) || "/";
const drive = /^[A-Za-z]:[\\/]/; // a Windows absolute path

// A relative or absolute link, resolved against the current file's folder.
function resolve(file, href, on) {
  let p;
  try { p = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  if (!p) return null;
  const parts = [];
  const full = p.startsWith("/") || (windows(on) && drive.test(p)) ? p : `${dirname(file, on)}/${p}`;
  for (const s of (windows(on) ? full.replace(/\\/g, "/") : full).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop(); else parts.push(s);
  }
  return windows(on) && drive.test(full) ? parts.join("/") : "/" + parts.join("/");
}

// A plain class: main.js (the View) owns it and forwards init, render and close.
export default class Viewer {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.file = p.file; this.source = false;
    if (!this.file) { this.error = "No file to show"; return; }
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const file = this.file;
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(file, { on: this.on });
        if (this.closed || this.file !== file) return;
        if (raw === null) { this.error = "This file is no longer available"; return; }
        if (raw.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const text = raw.length > LIMIT ? raw.slice(0, LIMIT) + "\n… (file truncated)" : raw;
        if (this.code && text === this.text) return;
        const syntax = await syntaxColors();
        if (this.closed || this.file !== file) return;
        this.code?.release();
        this.text = text; this.error = null;
        this.code = EditorState.new({ language: languageFor(file), readonly: true, value: text,
          font_family: settings().font_family, font_size: 12,
          syntax });
      } catch { if (this.file === file) this.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (!this.closed) cx.notify(); }
    });
  }

  // Local files reload when saved elsewhere; watchFolder only works on this machine.
  watch(cx) {
    if (this.on) return;
    const dir = dirname(this.file, this.on);
    if (this.watching === dir) return;
    this.watching = dir;
    cx.spawn(async cx => {
      try {
        while (!this.closed && this.watching === dir) {
          const changed = await watchFolder(dir);
          if (this.closed || this.watching !== dir) return;
          const slash = p => windows(this.on) ? p.replace(/\\/g, "/") : p, file = slash(this.file);
          if (changed.map(slash).some(c => c.endsWith(file) || file.startsWith(c + "/"))) this.load(cx);
        }
      } catch { if (this.watching === dir) this.watching = null; }
    });
  }

  // Linked files open in their own tab, like clicks in the Files panel.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) return cx.open_url(url);
    const next = resolve(this.file, url, this.on);
    if (!next || next === this.file) return;
    const space = focused()?.space ?? spaces().find(s => s.active)?.id;
    openFile({ file: next, on: this.on, space }, cx);
  }

  body(t) {
    if (!this.code) return div().p(16).text_color(t.dim).child(this.error || "Loading file…");
    if (!isMarkdown(this.file) || this.source) return Editor.new(this.code).flex_1().min_h(0);
    return v_flex().id(`fow-md-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
      .child(TextView.markdown(`fow-md-view-${this.file}`, this.text).selectable(true).scrollable(false).w_full()
        .text_size(14).text_color(t.foreground).on_link_click((url, cx) => this.followLink(url, cx)));
  }

  button(id, label, t, action) {
    return div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(6).text_size(12).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  render(_cx) {
    const t = theme();
    return v_flex().id("fow-viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ?? ""))
        .when(isMarkdown(this.file) && Boolean(this.code), el => el.child(this.button("fow-mode", this.source ? "Preview" : "Source", t,
          cx => { this.source = !this.source; cx.notify(); }))))
      .child(this.body(t));
  }

  close() {
    this.closed = true;
    this.code?.release(); this.code = null;
  }
}
