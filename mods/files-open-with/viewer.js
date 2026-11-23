// A file in its own tab, opened by panel.js with props { role: "viewer", file (absolute), on, edit }.
// Text files are editable right away: Auto save (Mod settings) saves after a pause, ⌘S saves any time.
// Markdown opens formatted (Source edits it); `edit` opens it in Source.
import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, watchFolder, theme, settings, focused, spaces, panes, run, shared } from "herdr";
import { openFile, TABS } from "./tabs.js";
import { syntaxColors, languageFor } from "./syntax.js";
import { saveFile } from "./fs.js";
import { prefs } from "./prefs.js";

const LIMIT = 400000;
const AUTO_SAVE_DELAY = 800;
const isMarkdown = path => /\.(md|markdown|mdx)$/i.test(path ?? "");
const dirname = path => path.slice(0, path.lastIndexOf("/")) || "/";
// A small bullet; the larger one earlier builds used is cleared too.
const DOT = " •", OLD_DOTS = [" ●"];

// A relative or absolute link, resolved against the current file's folder.
function resolve(file, href) {
  let p;
  try { p = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  if (!p) return null;
  const parts = [];
  for (const s of (p.startsWith("/") ? p : `${dirname(file)}/${p}`).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop(); else parts.push(s);
  }
  return "/" + parts.join("/");
}

// A plain class: main.js (the View) owns it and forwards init, render and close.
export default class Viewer {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.file = p.file; this.source = Boolean(p.edit); this.edits = 0;
    if (!this.file) { this.error = "No file to show"; return; }
    prefs().then(s => { this.autoSave = s.auto_save; });
    this.load(cx);
    this.watch(cx);
    // Once tabs.js has recorded this tab, clear a dot left from before a restart.
    cx.timer.after(2500, () => { if (!this.tab) { this.findTab(true); this.mark(); } });
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
        // Changed on disk: keep unsaved edits (and say so), otherwise take the new text.
        if (this.code && !this.truncated && raw.length <= LIMIT) {
          if (this.dirty) { this.stale = true; return; }
          this.raw = raw; this.text = text; this.stale = false;
          this.code.set_value(text);
          return;
        }
        this.syntax = await syntaxColors();
        if (this.closed || this.file !== file) return;
        this.raw = raw; this.text = text; this.error = null;
        this.truncated = raw.length > LIMIT;
        this.editor();
      } catch { if (this.file === file) this.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (!this.closed) cx.notify(); }
    });
  }

  // Truncated files stay read-only: saving would cut them short.
  editor() {
    this.code?.release();
    this.dirty = false; this.stale = false; this.saveError = null;
    this.mark();
    this.code = EditorState.new({ language: languageFor(this.file), readonly: this.truncated, value: this.text,
      font_family: settings().font_family, font_size: 12, syntax: this.syntax });
    if (this.truncated) return;
    this.code.on("change", (_e, cx) => this.changed(cx));
    this.code.focus();
  }

  changed(cx) {
    const dirty = this.code.value() !== this.text;
    // Only typing makes it dirty, and typing happens in the focused tab: that's this one.
    if (dirty && !this.tab) this.findTab();
    if (dirty !== this.dirty) { this.dirty = dirty; this.saved = false; cx.notify(); }
    this.mark();
    if (!dirty || !this.autoSave || this.stale) return;
    const edit = ++this.edits;
    cx.timer.after(AUTO_SAVE_DELAY, cx => { if (edit === this.edits && !this.closed) this.save(cx); });
  }

  // `force`: overwrite whatever is on disk now.
  save(cx, { force = false } = {}) {
    if (!this.code || this.truncated) return;
    if (this.saving) { this.again = true; return; }
    if (!this.dirty && !force) return;
    const text = this.code.value(), file = this.file;
    this.saving = true; this.saveError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const expected = force ? await readTextFile(file, { on: this.on }) : this.raw;
        await saveFile(file, text, expected, this.on);
        if (this.closed) return;
        this.raw = this.text = text; this.stale = false; this.saved = true;
        this.dirty = this.code.value() !== text;
        this.mark();
      } catch (e) {
        if (this.closed) return;
        if (e.stale) this.stale = true; else this.saveError = e.message ?? String(e);
      } finally {
        this.saving = false;
        // Typing during a save: save again once this one is done.
        if (this.again && !this.closed) { this.again = false; if (this.dirty && !this.stale) this.save(cx); }
        if (!this.closed) cx.notify();
      }
    });
  }

  // `recorded`: only the tab tabs.js recorded for this file, when exactly one is open.
  findTab(recorded = false) {
    const alive = tab => panes().some(p => p.tab === tab && p.mod === "files-open-with");
    const mine = Object.entries(shared(TABS) ?? {}).filter(([k, t]) => k.endsWith(`|${this.on ?? ""}|${this.file}`) && alive(t));
    if (mine.length === 1) return (this.tab = mine[0][1]);
    if (recorded) return;
    const f = focused();
    if (f?.pane && panes().some(p => p.pane === f.pane && p.mod === "files-open-with")) this.tab = f.tab;
  }

  // Unsaved: a dot after the tab's name, as in VS Code.
  // Keeps whatever the tab is called, so a name given by hand stays.
  mark() {
    if (!this.tab || this.closed) return;
    const tab = spaces().flatMap(s => s.tabs).find(t => t.id === this.tab);
    if (!tab || !panes().some(p => p.tab === this.tab && p.mod === "files-open-with")) { this.tab = null; return; }
    const mark = [DOT, ...OLD_DOTS].find(m => tab.name.endsWith(m));
    const bare = mark ? tab.name.slice(0, -mark.length) : tab.name;
    const name = (tab.named ? bare : this.file.split("/").pop()) + (this.dirty ? DOT : "");
    if (name !== tab.name) run("tab.rename", { id: this.tab, name });
  }

  // Drops unsaved edits and takes the text on disk.
  reload(cx) {
    this.dirty = false; this.stale = false; this.saveError = null; this.text = null;
    this.load(cx);
  }

  discard(cx) {
    this.code?.set_value(this.text);
    this.dirty = false; this.saveError = null;
    this.mark();
    cx.notify();
  }

  // Local files reload when saved elsewhere; watchFolder only works on this machine.
  watch(cx) {
    if (this.on) return;
    const dir = dirname(this.file);
    if (this.watching === dir) return;
    this.watching = dir;
    cx.spawn(async cx => {
      try {
        while (!this.closed && this.watching === dir) {
          const changed = await watchFolder(dir);
          if (this.closed || this.watching !== dir) return;
          if (changed.some(c => c.endsWith(this.file) || this.file.startsWith(c + "/"))) this.load(cx);
        }
      } catch { if (this.watching === dir) this.watching = null; }
    });
  }

  // Linked files open in their own tab, like clicks in the Files panel.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) return cx.open_url(url);
    const next = resolve(this.file, url);
    if (!next || next === this.file) return;
    const space = focused()?.space ?? spaces().find(s => s.active)?.id;
    openFile({ file: next, on: this.on, space }, cx);
  }

  body(t) {
    if (!this.code) return div().p(16).text_color(t.dim).child(this.error || "Loading file…");
    if (!isMarkdown(this.file) || this.source) return Editor.new(this.code).flex_1().min_h(0);
    return v_flex().id(`fow-md-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
      .child(TextView.markdown(`fow-md-view-${this.file}`, this.code.value()).selectable(true).scrollable(false).w_full()
        .text_size(14).text_color(t.foreground).on_link_click((url, cx) => this.followLink(url, cx)));
  }

  button(id, label, t, action, primary = false) {
    return div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(6).text_size(12)
      .when(primary, el => el.bg(t.solid).text_color(t.solid_foreground).hover(s => s.opacity(0.88)))
      .when(!primary, el => el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)))
      .cursor_pointer().on_click((_e, cx) => action(cx)).child(label);
  }

  actions(t) {
    if (!this.code) return [];
    if (this.stale) return [
      this.button("fow-reload", "Reload", t, cx => this.reload(cx)),
      this.button("fow-overwrite", "Overwrite", t, cx => this.save(cx, { force: true }), true),
    ];
    return [
      ...(this.dirty && !this.autoSave ? [
        this.button("fow-discard", "Discard", t, cx => this.discard(cx)),
        this.button("fow-save", this.saving ? "Saving…" : "Save", t, cx => this.save(cx), true),
      ] : []),
      ...(isMarkdown(this.file) ? [this.button("fow-mode", this.source ? "Preview" : "Source", t, cx => {
        this.source = !this.source; if (this.source) this.code.focus(); cx.notify();
      })] : []),
    ];
  }

  status(t) {
    const note = this.stale ? ["Changed on disk · reload to take it, or overwrite with your edits", t.blocked]
      : this.saveError ? [this.saveError, t.ansi1]
      : this.truncated ? ["Read-only · too large to edit here", t.dim]
      : this.saving ? ["Saving…", t.dim]
      : this.dirty ? [this.autoSave ? "Edited" : "Unsaved · ⌘S", t.dim]
      : this.saved ? ["Saved", t.dim] : null;
    return note ? div().flex_none().max_w(360).truncate().text_size(11.5).text_color(note[1]).child(note[0]) : null;
  }

  render(_cx) {
    const t = theme(), status = this.status(t);
    return v_flex().id("fow-viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.keystroke !== "cmd-s") return;
        cx.stop_propagation();
        this.save(cx);
      })
      .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ?? ""))
        .when(Boolean(status), el => el.child(status))
        .children(this.actions(t)))
      .child(this.body(t));
  }

  // With Auto save on, edits still waiting for the pause are saved as the tab closes.
  close() {
    if (this.autoSave && this.dirty && !this.stale && this.code && !this.saving)
      saveFile(this.file, this.code.value(), this.raw, this.on).catch(() => {});
    this.closed = true;
    this.code?.release(); this.code = null;
  }
}
