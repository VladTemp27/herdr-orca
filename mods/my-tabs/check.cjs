// node mods/my-tabs/check.cjs: the tab bar's sidebar button, and a rail turning into a hide.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const node = { items: [], handlers: {}, style: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key.startsWith("on_")) node.handlers[key] = args.at(-1);
      else if (key === "id") node.key = args[0];
      else node.style[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => !node || typeof node !== "object" ? null : node.key === id ? node : node.items.map(c => find(c, id)).find(Boolean) ?? null;

const state = {}, calls = [];
let sidebar, windowBlock;
let viewProps = {}, windowInfo = { platform: "macos" };
const env = {
  View: class {}, div: element, h_flex: element, svg: element, image: element,
  theme: () => new Proxy({}, { get: () => "#000" }), settings: () => ({ zoom: 1 }), window: () => windowInfo, props: () => viewProps,
  layout: () => ({ id: "root", children: [sidebar, ...(windowBlock ? [windowBlock] : [])] }), shared: (k) => state[k],
  run: (name, args) => calls.push([name, args == null ? args : JSON.parse(JSON.stringify(args))]), spaces: () => [], panes: () => [], focused: () => null,
  openOverlay() {}, exec() {}, nextCommand: () => new Promise(() => {}),
  localStorage: { getItem: () => null, setItem() {} },
};
const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
const context = vm.createContext(env);
vm.runInContext(source, context);
const tabs = new context.Mod();
tabs.init({}, { spawn() {} });

// Shown at full width: the button hides it, and says so.
sidebar = { id: "sidebar", size: { px: 268 } };
let button = find(tabs.render(), "sidebar-toggle");
assert.equal(button.style.tooltip, "Hide sidebar");
button.handlers.on_click();
assert.deepEqual(calls, [["layout.toggle", { id: "sidebar" }]]);

// Hidden: the button is still there, to show it again.
calls.length = 0;
sidebar = { id: "sidebar", hidden: true, size: { px: 268 } };
assert.equal(find(tabs.render(), "sidebar-toggle").style.tooltip, "Show sidebar");
assert.deepEqual(calls, [], "hidden is left alone");

// Herdr's brand button made a rail: hidden instead, back at the width it saved.
state["sidebar.width"] = 300;
sidebar = { id: "sidebar", size: { px: 76 } };
tabs.render();
assert.deepEqual(calls, [["layout.resize", { id: "sidebar", px: 300 }], ["layout.hide", { id: "sidebar" }]]);

// An old saved rail with no width to go back to: the layout's default.
calls.length = 0;
delete state["sidebar.width"];
tabs.render();
assert.equal(calls[0][1].px, 268);

// The normal Windows copy reveals the last block and owns the close-command loop.
calls.length = 0;
sidebar = { id: "sidebar", size: { px: 268 } };
windowBlock = { id: "window-buttons", hidden: true };
windowInfo = { platform: "windows", buttons: true };
let listeners = 0;
new context.Mod().init({}, { spawn() { listeners++; } });
assert.equal(listeners, 1);
assert.deepEqual(calls, [["layout.show", { id: "window-buttons" }]]);

// The window-only copy neither takes close commands nor renders tabs/sidebar controls.
calls.length = 0;
viewProps = { part: "window" };
const controls = new context.Mod();
controls.init({}, { spawn() { listeners++; } });
assert.equal(listeners, 1);
assert.deepEqual(calls, []);
const bar = controls.render();
assert.equal(find(bar, "sidebar-toggle"), null);
assert.equal(find(bar, "tab-new"), null);
for (const [id, command] of [["minimize", "window.minimize"], ["maximize", "window.maximize"], ["close-window", "window.close"]]) {
  find(bar, id).handlers.on_click();
  assert.deepEqual(calls.pop(), [command, undefined]);
}

console.log("my-tabs: ok");
