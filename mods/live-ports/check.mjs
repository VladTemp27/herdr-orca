// node mods/live-ports/check.mjs: this Windows computer by netstat, and a WSL machine still by lsof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const proc = (rows) => rows.join("\r\n") + "\r\n";
globalThis.herdr = {
  readTextFile: async () => "5.15-microsoft-standard-WSL2",
  terminals: () => [{ address: "t1", state: "live" }, { address: "t2", state: "live", parent: "t1" }, { address: "vps/t3", state: "live" }],
  hc: async ([, , address]) => ({ code: 0, stdout: JSON.stringify({ t1: { pid: 100, labels: { "herdr.space": "s1" } }, t2: { pid: 200, parent: "t1" } }[address]) }),
  exec: async (cmd, _args, o) => o?.on ? { code: 0, stdout: "p7\ncnode\nn*:8000\n" } : ({
    code: 0,
    stdout: cmd === "netstat" ? proc([
      "Active Connections", "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900",
      "  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN         300", // localized state
      "  TCP    [::]:3000              [::]:0                 LISTENING       300", // same pid:port, IPv6
      "  TCP    [::1]:5173             [::]:0                 EN ESCUCHA      400",
      "  TCP    127.0.0.1:51000        127.0.0.1:3000         ESTABLISHED     300", // not a listener
      "  UDP    0.0.0.0:5353           *:*                                    900",
    ]) : proc([
      "300 250 node.exe", "250 100 cmd.exe", "100 50 powershell.exe",
      "400 200 node.exe", "200 50 claude.exe",
      "900 600 svchost.exe", "600 900 wininit.exe", // a reused parent pid: a loop
    ]),
  }),
};
const src = readFileSync(new URL("./scan.js", import.meta.url), "utf8")
  .replace(/^import .* from "herdr";$/m, "const { exec, hc, readTextFile, terminals } = globalThis.herdr;");
const { scanPorts } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const r = await scanPorts([{ id: "w", machine: "wsl", tabs: [] }], [], [], "windows", null);
assert.deepEqual(r.bySpace, { s1: [
  { port: 3000, pid: 300, name: "node", address: "localhost:3000", machine: null, reachable: true },
  { port: 5173, pid: 400, name: "node", address: "localhost:5173", machine: null, reachable: true }, // a sub-agent's: its parent's space
] });
assert.deepEqual(r.external, [{ port: 135, pid: 900, name: "svchost", address: "localhost:135", machine: null, reachable: true }, { port: 8000, pid: 7, name: "node", address: "localhost:8000", machine: "wsl", reachable: true }]);
console.log("live-ports check passed");
// Cache regressions use fresh mocked OS snapshots; no native process is touched.
let phase = 0, lookups = 0, processReads = 0, failLookup = false;
const snapshots = [
  { shell: 100, pid: 300, space: "first", parent: 100, name: "node" },
  { shell: 101, pid: 400, space: "recovered", parent: 101, name: "node" },
  { shell: 101, pid: 400, space: "relabeled", parent: 101, name: "node" },
  { shell: 101, pid: 400, space: "relabeled", parent: 50, name: "other" },
];
globalThis.herdr = {
  terminals: () => [{ address: "t1", state: "live" }],
  readTextFile: async () => "",
  hc: async () => {
    if (failLookup) throw new Error("terminal disappeared");
    lookups++;
    const s = snapshots[phase];
    return { code: 0, stdout: JSON.stringify({ pid: s.shell, labels: { "herdr.space": s.space } }) };
  },
  exec: async (cmd) => {
    const s = snapshots[phase];
    if (cmd === "netstat") return { code: 0, stdout: `TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING ${s.pid}\n` };
    processReads++;
    return { code: 0, stdout: `${s.pid} ${s.parent} ${s.name}.exe\n${s.shell} 50 powershell.exe\n` };
  },
};
const fresh = await import(`data:text/javascript,${encodeURIComponent(src + "\n// recovery regression")}`);
let last;
for (; phase < snapshots.length; phase++) {
  last = await fresh.scanPorts([], [], [], "windows", last);
  if (phase < 3) assert.equal(last.bySpace[snapshots[phase].space]?.[0]?.pid, snapshots[phase].pid, `terminal snapshot ${phase}`);
  else {
    assert.deepEqual(last.bySpace, {}, "reused listener PID must not keep its old parent chain");
    assert.equal(last.external[0].name, "other");
  }
}
assert.equal(lookups, 4);
assert.equal(processReads, 4);
// A failed metadata refresh cannot retain ownership from the previous scan.
failLookup = true;
phase = 2;
last = await fresh.scanPorts([], [], [], "windows", last);
assert.deepEqual(last.bySpace, {});
assert.equal(last.external.length, 1);
console.log("terminal recovery and PID reuse check passed");
