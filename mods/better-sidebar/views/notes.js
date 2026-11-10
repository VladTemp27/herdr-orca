// Worktree notes, like Orca's worktree comments: one free-text note per checkout, for
// whatever you need to remember about it. Kept in shared state by [machine, folder], so a
// note stays with the worktree, not the space showing it: close and reopen it, the note's there.
// The editor opens as a dialog with props { view: "note", space }.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, theme, shared, setShared, spaces, openOverlay, closeOverlay } from "herdr";

const KEY = "worktree.notes";
const keyOf = (s) => JSON.stringify([s.machine ?? null, s.folder ?? s.id]);

export const noteOf = (s) => (s ? shared(KEY)?.[keyOf(s)] ?? "" : "");

// An empty note removes it.
export function setNote(s, text) {
  const notes = { ...(shared(KEY) ?? {}) };
  if (text.trim()) notes[keyOf(s)] = text.trim();
  else delete notes[keyOf(s)];
  setShared(KEY, notes);
}

export const openNote = (s) =>
  openOverlay({ mod: "better-sidebar", kind: "dialog", width: 460, height: 290, props: { view: "note", space: s.id } });

export class Note {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props().space) ?? null;
    this.handle = cx.focus_handle();
    this.input = TextareaState.new({ value: noteOf(this.space), placeholder: "Anything to remember about this worktree", rows: 7 });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  close() {
    closeOverlay(props().overlay);
  }

  save() {
    if (this.space) setNote(this.space, this.input.value());
    this.close();
  }

  render() {
    const t = theme();
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("note-dialog").track_focus(this.handle).w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.close(); }
        else if (e.key === "enter" && e.modifiers.platform) { cx.stop_propagation(); this.save(); }
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().text_size(15).font_semibold().child("Note"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.space?.name ?? ""))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("⌘↩ save · Esc")))
      .child(div().id("note-text").p(10).rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12.8).text_color(t.foreground)))
      .child(h_flex().gap(8).justify_end()
        .child(button("note-cancel", "Cancel", false, () => this.close()))
        .child(button("note-save", "Save", true, () => this.save())));
  }
}
