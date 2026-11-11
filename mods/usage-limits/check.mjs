// node mods/usage-limits/check.mjs: sh.js finds Git's sh.exe on Windows (not on PATH there),
// plain `sh` elsewhere and on other machines, and runs Unix tools through it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const windows = process.platform === "win32";
globalThis.herdr = {
  window: () => ({ platform: windows ? "windows" : "macos" }),
  exec: async (cmd, args = []) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
};
const src = readFileSync(new URL("./sh.js", import.meta.url), "utf8")
  .replace(/^import .* from "herdr";$/m, "const { exec, window } = globalThis.herdr;");
const { shProgram, unix } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

assert.equal(await shProgram("vps"), "sh");
const program = await shProgram();
if (windows) {
  assert.match(program, /\/bin\/sh\.exe$/);
  assert.ok(existsSync(program), program);
} else assert.equal(program, "sh");
assert.equal((await unix("test", ["-d", "."])).code, 0);
assert.equal((await unix("test", ["-f", "no such file"])).code, 1);
console.log("sh check passed:", program);
