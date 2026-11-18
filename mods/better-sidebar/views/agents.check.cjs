// node mods/better-sidebar/views/agents.check.cjs: agent labels read panes once per render, not once per label.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const tabs = [], paneList = [];
for (let i = 0; i < 60; i++) {
  tabs.push({ id: `tb${i}`, name: i % 2 ? "claude" : `task ${i}` });
  paneList.push({ tab: `tb${i}`, terminal: `t${i}`, program: { agent: true, name: "claude", key: "claude" }, title: `fix bug ${i}` });
  paneList.push({ tab: `tb${i}`, terminal: `s${i}`, focused: true });
}
let reads = 0;
const env = {
  spaces: () => [{ tabs }],
  panes: () => { reads++; return paneList.map((p) => ({ ...p })); },
};
// Only the pure helpers: everything above the view classes, imports and exports stripped.
const source = fs.readFileSync(path.join(__dirname, "agents.js"), "utf8");
const helpers = source.slice(source.indexOf("const clean"), source.indexOf("// A row reads"))
  .replace(/^export /gm, "") + "\nObject.assign(globalThis, { agentLabel, lead });";
const ctx = vm.createContext(env);
vm.runInContext(helpers, ctx);
const { agentLabel, lead } = ctx;

const label = agentLabel();
const agents = tabs.map((t, i) => ({ address: `t${i}`, tab: t.id }));
for (let round = 0; round < 3; round++) for (const a of agents) label(a);
assert.equal(reads, 1, "one pane read for every label in a render");

// Same answers as before: an automatic program-named tab takes the agent's title, a named tab keeps its name.
assert.equal(label(agents[1]), "fix bug 1");
assert.equal(label(agents[0]), "task 0");
assert.equal(label({ address: "x", tab: "gone", title: "orphan" }), "orphan");
// The agent leads its tab, ahead of the focused shell.
assert.equal(lead(tabs[3], paneList).terminal, "t3");

console.log("agents: ok");
