// node mods/desktop-notifications/check.mjs: on Windows an alert is one toast.ps1 call whose
// only data is URI-encoded JSON (agent titles come from programs: never script), and a
// clear removes that toast by its terminal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calls = [];
globalThis.herdr = {
  exec: async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: "", stderr: "" }),
  window: () => ({ platform: "windows" }),
  appHome: () => "C:/Users/x/.config/herdr-app",
  home: () => "C:/Users/x",
  agents: () => [], terminals: () => [], focused: () => null, props: () => ({}),
};
globalThis.gpui = { View: class {}, div: () => ({}) };
globalThis.alerts = await import(new URL("./alerts.js", import.meta.url));
const src = readFileSync(new URL("./main.js", import.meta.url), "utf8")
  .replace(/^import (\{[^}]*\}) from "gpui-kit";$/m, "const $1 = globalThis.gpui;")
  .replace(/^import (\{[^}]*\}) from "herdr";$/m, "const $1 = globalThis.herdr;")
  .replace(/^import (\{[^}]*\}) from "\.\/alerts\.js";$/m, "const $1 = globalThis.alerts;");
const { default: DesktopNotifications } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const evil = `x'; Remove-Item C:\\ -Recurse; "<&>"`;
const d = new DesktopNotifications();
await d.deliver([{ address: "t3", alert: "blocked", title: "Claude Code needs you", subtitle: "web / 1", body: evil }], ["t4"]);

const [post, clear] = calls;
const script = "C:/Users/x/.config/herdr-app/mods/desktop-notifications/toast.ps1";
assert.deepEqual(post.slice(0, 9), ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "post", post[8]]);
assert.match(post[8], /^[\w%.!~*'()-]+$/); // no space or quote reaches the command line
assert.deepEqual(JSON.parse(decodeURIComponent(post[8])), {
  aumid: "Herdr.DesktopNotifications", tag: "t3", title: "Claude Code needs you", subtitle: "web / 1", body: evil,
  icon: "C:\\Users\\x\\.config\\herdr-app\\frame\\welcome\\herdr.png",
});
assert.deepEqual(clear.slice(6, 8), [script, "clear"]);
assert.deepEqual(JSON.parse(decodeURIComponent(clear[8])), { aumid: "Herdr.DesktopNotifications", tag: "t4" });

// A clicked toast's link (click.js, Windows only): any page can open herdr-agent: links, so
// only an address reaches the command line. A stand-in for herdr-app.exe logs what it gets.
if (process.platform === "win32") {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(`${tmpdir()}/herdr-click-`);
  writeFileSync(`${dir}/herdr.cmd`, '@echo %*>> "%~dp0ran.txt"\r\n');
  const links = ["herdr-agent:t1", "herdr-agent:vps/t3/", "herdr-agent:t1&calc", 'herdr-agent:t1" & calc & "', "herdr-agent:t1 --name x", "herdr-agent:"];
  for (const link of links) spawnSync("wscript.exe", ["//B", "//Nologo", fileURLToPath(new URL("./click.js", import.meta.url)), `${dir}\\herdr.cmd`, link]);
  assert.deepEqual(read(`${dir}/ran.txt`, "utf8").trim().split(/\r?\n/), ["do agent.focus --terminal t1", "do agent.focus --terminal vps/t3"]);
  rmSync(dir, { recursive: true, force: true });
}
console.log("desktop-notifications check passed");
