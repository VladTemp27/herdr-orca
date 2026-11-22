// Read-only PR discovery for each [machine, checkout]. This observer is separate
// from space rendering so frequent redraws never launch Git or GitHub commands.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";

// The last status, ETags and check times survive restarts, so a reopened app shows the
// badges at once and asks GitHub only what may have changed (304s are free).
const saved = () => `${appHome()}/data/better-sidebar/pr-status.json`;

export const PR_POLL_MS = 60000;
const MIN = 60000;
const ISSUE_TTL = 10 * MIN;
const HOVER_MIN_MS = 20000; // a hovered row asks GitHub again at most this often
const PENDING = /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING|REQUESTED/i;

// How long a branch's PR status may stand without a repo change: CI finishing doesn't
// change the PR on GitHub, so running checks are rechecked often; settled ones rarely.
function standFor(prs) {
  const pr = prs?.[0];
  if (!pr) return 30 * MIN;
  if (pr.state !== "OPEN") return 60 * MIN;
  const running = (pr.statusCheckRollup ?? []).some((c) => !c.conclusion && PENDING.test(String(c.status || c.state)));
  return running ? 2 * MIN : 10 * MIN;
}
export const prPlaceKey = (machine, folder) => JSON.stringify([machine ?? null, folder]);
const PR_FIELDS =
  "id,number,title,url,state,isDraft,headRefName,headRepository,updatedAt,statusCheckRollup,body,closingIssuesReferences";
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+([\w.-]+\/[\w.-]+)?#(\d+)/i;
// issue-12-title, feat/393, 393-fix: a number that starts a branch path segment.
const BRANCH_NUMBER = /(?:^|\/)(?:issue-|gh-)?(\d+)(?=$|[-_/])/;

/** Terminal PR states win over draft/CI flags left over from when it was open. */
export function prAppearance(pr, colors) {
  if (pr.state === "MERGED") return { icon: "merged", color: colors.ansi5, label: "Merged" };
  if (pr.state === "CLOSED") return { icon: "closed", color: colors.ansi1, label: "Closed" };
  if (pr.isDraft) return { icon: "draft", color: colors.dim, label: "Draft" };
  const failed = (pr.statusCheckRollup ?? []).some((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
      String(check.conclusion || check.state || check.status).toUpperCase(),
    ),
  );
  return {
    icon: "pull-request",
    color: failed ? colors.ansi1 : colors.ansi2,
    label: failed ? "Checks failed" : "Open",
  };
}

/** Only github.com remotes are supported. Never pass an arbitrary remote URL to gh. */
export function githubRepository(url) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  )?.[1];
}

/**
 * One observer per sidebar. Git and gh run on the checkout's machine, using its
 * existing authentication. No helper executable is required.
 * Maps include the machine in their keys so remote paths cannot collide.
 */
export class PRStatusObserver {
  constructor() {
    this.places = new Map(); // Current checkout snapshots, replaced on refresh.
    this.checked = new Map(); // Checkout key -> last attempt time and branch.
    this.entries = new Map(); // Checkout key -> last published PRs or error.
    this.cache = new Map(); // gh argument list -> short-lived response cache.
    this.probes = new Map(); // Machine/repository -> { at, etag, changed }.
    this.loaded = false;
  }

  async load(cx) {
    try {
      const d = JSON.parse(await fs.readFile(saved(), "utf8"));
      for (const [k, v] of d.entries ?? []) if (!this.entries.has(k)) this.entries.set(k, v);
      for (const [k, v] of d.checked ?? []) if (!this.checked.has(k)) this.checked.set(k, v);
      // A restored probe only carries its ETag: the next check asks GitHub with it.
      for (const [k, v] of d.probes ?? []) if (!this.probes.has(k)) this.probes.set(k, { at: 0, etag: v.etag, changed: false });
    } catch {}
    this.loaded = true;
    cx.notify();
  }

  async save() {
    const d = { entries: [...this.entries], checked: [...this.checked], probes: [...this.probes].map(([k, v]) => [k, { etag: v.etag }]) };
    try { await fs.mkdir(`${appHome()}/data/better-sidebar`, { recursive: true }); await fs.writeFile(saved(), JSON.stringify(d)); } catch {}
  }

  // Did anything in these repositories change on GitHub? One conditional request per
  // machine and repo each minute; a 304 (unchanged) costs no rate limit.
  async repoChanged(repositories, machine) {
    let changed = false;
    for (const repo of repositories) {
      const key = JSON.stringify([machine ?? null, repo]);
      const seen = this.probes.get(key);
      if (seen && Date.now() - seen.at < PR_POLL_MS - 5000) { changed ||= seen.changed; continue; }
      const args = ["api", "-i", `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=1`];
      if (seen?.etag) args.splice(2, 0, "-H", `If-None-Match: ${seen.etag}`);
      const r = await exec("gh", args, { on: machine });
      if (r.code !== 0) throw new Error((r.stderr || "GitHub unavailable; check gh auth login").trim());
      const out = r.stdout ?? "";
      const same = Boolean(seen?.etag) && /^HTTP\/[\d.]+ 304/m.test(out);
      const etag = same ? seen.etag : (/^etag:\s*(.+?)\s*$/im.exec(out)?.[1] ?? null);
      this.probes.set(key, { at: Date.now(), etag, changed: !same });
      changed ||= !same;
    }
    return changed;
  }

  refresh(places, cx) {
    if (!this.loaded) {
      if (!this.loading) { this.loading = true; cx.spawn(async (cx) => this.load(cx)); }
      return;
    }
    this.places = new Map(
      places
        .filter((place) => place.folder)
        .map((place) => [prPlaceKey(place.machine, place.folder), place]),
    );
    for (const key of this.entries.keys()) if (!this.places.has(key)) this.entries.delete(key);
    for (const key of this.checked.keys()) if (!this.places.has(key)) this.checked.delete(key);
    for (const [key, value] of this.cache)
      if (Date.now() - value.at >= ISSUE_TTL) this.cache.delete(key);
    if (this.busy) return;

    const due = [...this.places].filter(([key, place]) => {
      const last = this.checked.get(key);
      return !last || last.branch !== place.branch || Date.now() - last.at >= PR_POLL_MS;
    });
    // checkNew runs frequently. Do not spawn tasks or redraw on cache hits.
    if (!due.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        for (const [key, place] of due) {
          if (!this.isCurrent(key, place)) continue;
          this.checked.set(key, { at: Date.now(), branch: place.branch });
          try {
            const { prs, issue, kept } = await this.lookup(place, this.entries.get(key));
            if (this.isCurrent(key, place)) {
              const previous = this.entries.get(key);
              this.entries.set(key, { prs, issue, branch: place.branch, updated: kept ? previous.updated : Date.now() });
            }
          } catch (error) {
            if (this.isCurrent(key, place)) {
              const previous = this.entries.get(key);
              // Retain last-good status on a network error, but never carry a
              // previous branch's PR across a branch switch.
              this.entries.set(key, {
                prs: previous?.branch === place.branch ? previous.prs : [],
                issue: previous?.branch === place.branch ? previous.issue : null,
                branch: place.branch,
                error: error.message,
                updated: previous?.updated,
              });
            }
          }
          cx.notify();
        }
      } finally {
        this.busy = false;
        await this.save();
      }
    });
  }

  // A hovered row's checkout, asked again now (at most every HOVER_MIN_MS). done(entry)
  // gets the result. Returns whether a request started.
  refreshNow(place, cx, done) {
    const key = prPlaceKey(place.machine, place.folder);
    this.hovered ??= new Map();
    if (!place.folder || Date.now() - (this.hovered.get(key) ?? 0) < HOVER_MIN_MS) return false;
    this.hovered.set(key, Date.now());
    cx.spawn(async (cx) => {
      let ok = true;
      try {
        const { prs, issue, branch } = await this.lookup(place, null, true);
        this.entries.set(key, { prs, issue, branch, updated: Date.now() });
        this.checked.set(key, { at: Date.now(), branch });
      } catch { ok = false; }
      cx.notify();
      await this.save();
      done?.(this.entries.get(key), ok);
    });
    return true;
  }

  // A lookup may finish after navigation or a branch switch. Publish only if
  // the caller's checkout snapshot still describes a tracked space.
  isCurrent(key, place) {
    return this.places.has(key) && this.places.get(key).branch === place.branch;
  }

  // force: a hovered row; ask GitHub now, CI included, whatever the probe says.
  async lookup(place, previous, force = false) {
    const git = (args) =>
      exec("git", ["--no-optional-locks", ...args], { cwd: place.folder, on: place.machine });
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.code !== 0) {
      if (head.code === 1 || /not a git repository/i.test(head.stderr ?? "")) return { prs: [], issue: null, branch: null };
      throw new Error("Cannot read checkout branch");
    }
    const branch = head.stdout.trim();
    const repositories = await this.repositories(git);
    // Same branch, nothing changed on GitHub, and not yet due: keep what's shown.
    const fresh = force || (await this.repoChanged(repositories, place.machine));
    if (previous?.branch === branch && !previous.error && !fresh && Date.now() - (previous.updated ?? 0) < standFor(previous.prs))
      return { prs: previous.prs, issue: previous.issue, branch, kept: true };
    const prs = await this.findPRs(git, branch, repositories, place.machine, fresh);
    return { prs, issue: await this.findIssue(git, branch, repositories, prs, place.machine, fresh), branch };
  }

  async repositories(git) {
    const remotes = await git(["remote"]);
    if (remotes.code !== 0) throw new Error("Cannot read Git remotes");
    const repositories = new Set();
    for (const name of remotes.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      const result = await git(["remote", "get-url", name]);
      if (result.code !== 0) throw new Error("Cannot read Git remote URL");
      const repository = githubRepository(result.stdout);
      if (repository) repositories.add(repository);
    }
    return repositories;
  }

  // The issue this checkout works on: the link Start wrote, the PR's closing references
  // or "Closes #N", else a number in the branch name that GitHub confirms is an issue.
  async findIssue(git, branch, repositories, prs, machine, fresh = false) {
    const pr = prs[0], repo = pr?.repository ?? [...repositories][0];
    const link = await git(["config", "--get", `branch.${branch}.herdr-issue`]);
    const bound = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(link.stdout?.trim() ?? "");
    const closing = pr?.closingIssuesReferences?.[0], body = CLOSES.exec(pr?.body ?? "");
    const guess = BRANCH_NUMBER.exec(branch);
    const [where, number] = bound ? [bound[1], bound[2]]
      : closing ? [closing.repository?.owner?.login ? `${closing.repository.owner.login}/${closing.repository.name}` : repo, closing.number]
      : body ? [body[1] ?? repo, body[2]]
      : guess ? [repo, guess[1]] : [];
    if (!where || !number) return null;
    try {
      const issue = await this.query(["issue", "view", String(number), "--repo", where, "--json", "number,title,state,url"], machine, fresh ? 0 : ISSUE_TTL);
      // gh answers for PR numbers too: only a real issue counts.
      return issue.url?.includes("/issues/") ? { ...issue, repository: where } : null;
    } catch {
      return null;
    }
  }

  async findPRs(git, branch, repositories, machine, fresh = false) {
    // Explicit worktree bindings survive local branch renames and take
    // precedence over guessing a PR from matching head branch names.
    const association = await git(["config", "--get", `branch.${branch}.herdr-pr`]);
    if (association.code !== 0 && association.code !== 1)
      throw new Error("Cannot read PR association");
    const binding = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(association.stdout?.trim() ?? "");
    if (binding) {
      const pr = await this.query([
        "pr",
        "view",
        binding[2],
        "--repo",
        binding[1],
        "--json",
        PR_FIELDS,
      ], machine, fresh ? 0 : PR_POLL_MS);
      return [{ ...pr, repository: binding[1] }];
    }

    const candidates = [];
    const knownHeads = new Set([...repositories].map((repo) => repo.toLowerCase()));
    for (const repository of repositories) {
      const found = await this.query([
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        PR_FIELDS,
      ], machine, fresh ? 0 : PR_POLL_MS);
      for (const pr of found) {
        // Branch names are not unique across forks. Only show PRs whose head
        // repository is one of this checkout's remotes, not somebody else's fork.
        if (
          pr.headRefName === branch &&
          knownHeads.has(pr.headRepository?.nameWithOwner?.toLowerCase())
        ) {
          candidates.push({ ...pr, repository });
        }
      }
    }
    const matches = [
      ...new Map(candidates.map((pr) => [pr.id ?? `${pr.repository}#${pr.number}`, pr])).values(),
    ].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    // A reused branch should show its current PR, not a historical merged one.
    const open = matches.filter((pr) => pr.state === "OPEN");
    return open.length ? open : matches.slice(0, 1);
  }

  // maxAge 0: the repo changed (or the row is hovered), ask again.
  async query(args, machine, maxAge = PR_POLL_MS) {
    const key = JSON.stringify([machine ?? null, args]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < maxAge) return cached.data;
    const result = await exec("gh", args, { on: machine });
    if (result.code !== 0)
      throw new Error((result.stderr || "GitHub unavailable; check gh auth login").trim());
    const data = JSON.parse(result.stdout);
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }
}
