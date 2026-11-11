// Git and GitHub reads for the Create worktree dialog. Git runs on the space's
// machine (`on`); gh runs here with -R, using the person's own login.
import { exec, panes, window } from "herdr";

// Same place as Herdr's worktree mod: <home>/.herdr/worktrees/<repo>/<branch, slashes as dashes>.
export const ROOT = (home) => `${home}/.herdr/worktrees`;
export const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const titleSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
// Normalize local Windows paths only; a remote machine may have case-sensitive Unix paths.
export const norm = (p, on) => (p && !on && window()?.platform === "windows" ? p.replace(/\\/g, "/").toLowerCase() : p);
export const tilde = (path, home, on) => (home && norm(path, on).startsWith(norm(home, on)) ? `~${path.slice(home.length)}` : path);

// exec stops a command after 30s unless told otherwise: worktree add and fetch on a big repo pass up to 10 minutes.
export async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) }).catch((e) => ({ code: 1, stderr: String(e) }));
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

async function gh(args) {
  const r = await exec("gh", args).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code !== 0) throw Error((r.stderr || r.stdout || "gh failed").trim());
  return JSON.parse(r.stdout || "null");
}

// Where a space is now: its first terminal's live folder, else where it was made.
export function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

const githubRepo = (url) =>
  /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;

// The repo a folder is in: { main, name, gh }. null outside git.
export async function repoOf(folder, on) {
  if (!folder) return null;
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const origin = await git(main, ["remote", "get-url", "origin"], on);
  return { main, name: main.split("/").pop(), gh: origin.ok ? githubRepo(origin.out) : null };
}

// Branches and checkouts: local, remote-only (origin/*, from the last fetch) and worktrees.
export async function branches(repo, on) {
  const refs = await git(repo.main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes/origin"], on);
  const local = [], remote = [];
  for (const line of refs.out.split("\n").filter(Boolean)) {
    const [ref, at] = line.split("\t");
    if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice(11), at: Number(at) || 0 });
    else if (ref !== "refs/remotes/origin/HEAD") remote.push({ name: ref.slice(20), at: Number(at) || 0 });
  }
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  const worktrees = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(18) ?? null;
    if (path && !lines.some((l) => l === "bare" || l.startsWith("prunable"))) worktrees.push({ path, branch, main: worktrees.length === 0 });
  }
  const head = await git(repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], on);
  const current = await git(repo.main, ["branch", "--show-current"], on);
  const names = new Set(local.map((b) => b.name));
  return {
    local, worktrees,
    remote: remote.filter((b) => !names.has(b.name)),
    allRemote: remote,
    base: head.ok && head.out ? head.out : current.out || "HEAD",
  };
}

// Bodies and closing references let an issue find the PR that's already working on it.
export const openPRs = (repo) =>
  gh(["pr", "list", "-R", repo, "--limit", "40", "--json", "number,title,headRefName,body,closingIssuesReferences"]);

// The open PR working on issue `n`: GitHub's link, "Closes #n" in its body, or its branch.
export function prFor(prs, n, branch) {
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#${n}\\b`, "i");
  return prs.find((p) => (p.closingIssuesReferences ?? []).some((r) => r.number === n))
    ?? prs.find((p) => closes.test(p.body ?? ""))
    ?? prs.find((p) => p.headRefName === branch);
}

// A quick check before git's own (check-ref-format) at create time.
export const badBranch = (b) =>
  !b || /[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(b);
export const openIssues = (repo) =>
  gh(["issue", "list", "-R", repo, "--limit", "40", "--json", "number,title"]);

// "#123", "123" or a GitHub issue/PR URL: { number, kind? }.
export function parseRef(text) {
  const url = /github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)/.exec(text);
  if (url) return { number: Number(url[2]), kind: url[1] === "pull" ? "pr" : "issue" };
  const num = /^#?(\d+)$/.exec(text.trim());
  return num ? { number: Number(num[1]) } : null;
}

// What #N is: a PR (with its head branch) or an issue.
export async function lookup(repo, number) {
  const kind = await gh(["api", `repos/${repo}/issues/${number}`, "--jq", "{pr: (.pull_request != null), title}"]);
  if (!kind.pr) return { kind: "issue", number, title: kind.title };
  const pr = await gh(["pr", "view", String(number), "-R", repo, "--json", "number,title,headRefName"]);
  return { kind: "pr", number, title: pr.title, head: pr.headRefName };
}
