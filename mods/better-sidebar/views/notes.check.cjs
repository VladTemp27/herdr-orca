// node mods/better-sidebar/views/notes.check.cjs: worktree notes are kept per checkout and edited in the dialog.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const state = {}, overlays = [], closed = [];
let text = "";
const element = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => element()) });
const env = {
  div: element, v_flex: element, h_flex: element, Textarea: { new: element },
  TextareaState: { new: ({ value }) => { text = value; return { value: () => text, focus() {} }; } },
  theme: () => ({}), shared: (k) => state[k], setShared: (k, v) => { state[k] = JSON.parse(JSON.stringify(v)); },
  openOverlay: (o) => overlays.push(o), closeOverlay: (id) => closed.push(id),
  spaces: () => [wt], props: () => ({ view: "note", space: "s1", overlay: "o1" }),
};
const wt = { id: "s1", name: "fix login", machine: null, folder: "/w/fix-login" };
const source = fs.readFileSync(path.join(__dirname, "notes.js"), "utf8")
  .replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "")
  + "\nObject.assign(globalThis, { noteOf, setNote, openNote, Note });";
const ctx = vm.createContext(env);
vm.runInContext(source, ctx);
const { noteOf, setNote, openNote, Note } = ctx;

// None yet; set one; it's the worktree's, not the space's: a new space on the same folder sees it.
assert.equal(noteOf(wt), "");
setNote(wt, "  needs the staging .env  \n");
assert.equal(noteOf(wt), "needs the staging .env");
assert.equal(noteOf({ id: "s9", machine: null, folder: "/w/fix-login" }), "needs the staging .env");
// Same folder on another machine is another checkout.
assert.equal(noteOf({ id: "s1", machine: "vps", folder: "/w/fix-login" }), "");
assert.equal(noteOf(null), "");

// The dialog opens with the note, saves edits, and an empty save removes it.
openNote(wt);
assert.deepEqual(JSON.parse(JSON.stringify(overlays.at(-1).props)), { view: "note", space: "s1" });
const dialog = new Note();
dialog.init({}, { focus_handle: () => ({}), timer: { after() {} } });
assert.equal(text, "needs the staging .env");
text = "line one\nline two";
dialog.save();
assert.equal(noteOf(wt), "line one\nline two");
assert.deepEqual(closed, ["o1"]);
text = "   ";
dialog.save();
assert.deepEqual(state["worktree.notes"], {});

console.log("notes: ok");
