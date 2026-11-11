// node mods/resources/check.mjs: Meter.measure on canned procs.ps1 output (CRLF, as Windows prints it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.herdr = {
  window: () => ({ platform: "windows" }),
  appHome: () => "C:/home/.config/herdr-app",
  hc: async () => ({ code: 0, stdout: JSON.stringify({ pid: 100, labels: { "herdr.space": "s1", "herdr.tab": "tb1" } }) }),
  exec: async (cmd, args) => {
    assert.equal(cmd, "powershell.exe");
    assert.equal(args.at(-1), "C:/home/.config/herdr-app/mods/resources/procs.ps1");
    return { code: 0, stdout: ["1 0 1.0 512 herdr-app", "50 1 5.0 1024 herdr-core", "100 50 10.0 2048 powershell", "300 100 40.0 4096 node", ""].join("\r\n") };
  },
};
const src = readFileSync(new URL("./measure.js", import.meta.url), "utf8")
  .replace(/^import .* from "herdr";$/m, "const { exec, hc, appHome, window } = globalThis.herdr;");
const { Meter } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const snap = await new Meter().measure(
  [{ address: "t1", state: "live", program: { name: "PowerShell" } }],
  [{ id: "s1", name: "web", tabs: [{ id: "tb1", name: "1" }] }],
  2,
);
const [s] = snap.spaces;
assert.equal(s.name, "web");
assert.equal(s.cpu, 25); // (10 + 40) of one core, over 2 cores
assert.equal(s.rss, 6144);
assert.equal(s.top.name, "node");
assert.deepEqual([snap.app.cpu, snap.app.rss], [3, 1536]); // herdr-app + herdr-core, minus the terminal
assert.deepEqual(snap.total, { cpu: 28, rss: 7680 });
console.log("resources check passed");
