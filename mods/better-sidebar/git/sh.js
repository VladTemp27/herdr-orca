// `sh` and Unix tools that work on Windows too. Git for Windows puts only Git\cmd on PATH,
// so its sh.exe is found from `git --exec-path`; Git's bin\sh.exe puts its Unix tools (cp,
// find, sort...) first on the script's PATH. macOS, Linux and other machines: plain `sh`.
// The same file is in better-sidebar/git, new-project, new-worktree and usage-limits:
// keep the copies identical.
import { exec, window } from "herdr";

let gitSh;

// The program to run as `sh`, here (no `on`) or on another machine.
export function shProgram(on) {
  if (on || window()?.platform !== "windows") return Promise.resolve("sh");
  return (gitSh ??= exec("git", ["--exec-path"])
    .then((r) => (r.code === 0 ? `${r.stdout.trim().replace(/\/[^/]+\/libexec\/git-core$/, "")}/bin/sh.exe` : "sh"))
    .catch(() => "sh"));
}

// A Unix tool by name (cp, mkdir, test...), through that sh on Windows.
export async function unix(cmd, args = [], options = {}) {
  const program = await shProgram(options.on);
  return program === "sh" ? exec(cmd, args, options) : exec(program, ["-c", '"$0" "$@"', cmd, ...args], options);
}
