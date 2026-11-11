// node mods/usage-limits/check.mjs: sh.js finds Git's sh.exe on Windows (not on PATH there),
// plain `sh` elsewhere and on other machines, and runs Unix tools through it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

// Codex's free limit resets: from its reply to the panel's line. No field, no line; 0 still shows.
const { parse } = await import("./providers/codex.js");
const { cardModel } = await import("./lib/view.js");
const now = 1_790_000_000, day = 86400;
const line = (rateLimitResetCredits) => {
  const result = { rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } }, rateLimitResetCredits };
  const report = parse(JSON.stringify({ id: 2, result }), now);
  const r = cardModel({ codex: { report, installed: true } }, now, [{ id: "codex", name: "Codex", icon: "" }]).groups[0].resets;
  return r && [r.text, r.expiry].filter(Boolean).join(" · ");
};
assert.equal(line(undefined), null);
assert.equal(line(null), null);
assert.equal(line({ availableCount: 0, credits: [] }), "0 rate-limit resets available");
assert.equal(line({ availableCount: 1, nextExpiresAt: now + 3600, credits: null }), "1 rate-limit reset available · Expires in 1h 0m");
assert.equal(line({ availableCount: 2, credits: [
  { status: "used", expiresAt: now + day },
  { status: "available", expiresAt: now + 5 * day },
  { status: "available", expiresAt: now + 3 * day },
] }), "2 rate-limit resets available · Next expires in 3d 0h");
assert.equal(line({ availableCount: 2, credits: [{ status: "available", expiresAt: now - 60 }] }), "2 rate-limit resets available");
console.log("reset credits check passed");

// Spending a reset, against a stand-in for codex, so no real credit is ever touched.
const { parseReset } = await import("./providers/codex.js");
const answer = (m) => parseReset(`banner\n{"id":1,"result":{}}\n${JSON.stringify({ id: 2, ...m })}\n`);
const outcome = (name) => answer({ result: { outcome: name } });
for (const name of ["reset", "alreadyRedeemed"]) assert.deepEqual([outcome(name).ok, outcome(name).settled], [true, true], name);
for (const name of ["nothingToReset", "noCredit"]) assert.deepEqual([outcome(name).ok, outcome(name).settled], [false, true], name);
// Unknown results keep the key, so a retry can't spend a second credit.
assert.deepEqual(answer({ error: { message: "boom" } }), { ok: false, settled: false, message: "boom" });
assert.equal(parseReset("").settled, false);
assert.equal(outcome("somethingNew").settled, false);

const dir = mkdtempSync(`${tmpdir()}/ul-reset-`).replaceAll("\\", "/");
const sent = `${dir}/sent`;
writeFileSync(`${dir}/fake-codex`, `#!/bin/sh
while read -r l; do
  printf '%s\\n' "$l" >> "${sent}"
  case "$l" in *consume*) echo '{"id":2,"result":{"outcome":"reset"}}' ;; esac
done
`, { mode: 0o755 });
const helper = fileURLToPath(new URL("./helpers/codex-reset.sh", import.meta.url)).replaceAll("\\", "/");
const spend = (key) => spawnSync(program, [helper, key], { encoding: "utf8", env: { ...process.env, HERDR_USAGE_CODEX_BIN: `${dir}/fake-codex` } });
const good = spend("abc-123");
assert.equal(good.status, 0, good.stderr);
assert.equal(parseReset(good.stdout).ok, true);
const lines = readFileSync(sent, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.deepEqual(lines.filter((l) => l.id === 2), [{ jsonrpc: "2.0", id: 2, method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: "abc-123" } }]);
rmSync(sent);
assert.equal(spend('x"y').status, 2);
assert.equal(existsSync(sent), false);
rmSync(dir, { recursive: true });
console.log("reset button check passed");
