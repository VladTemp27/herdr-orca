import { spaces, run, openOverlay, closeOverlay } from "herdr";

// Start or open a worktree for an issue or PR; keep the provider reference on external issues.
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

// A PR's head branch, or a branch named for the issue (issue-12-…, dev/feat/12, feat/12-title).
export function spaceFor(item, pr) {
  const issue = new RegExp("(?:^|/)(?:issue-)?" + String(item.number) + "(?:$|-)");
  return spaces().find((s) => s.branch && (pr ? s.branch === item.headRefName : issue.test(s.branch)));
}

// folder is a checkout of the repo on machine, so the dialog knows the project.
export async function startWorkspace({ machine = null, folder, item, pr, overlay }) {
  const existing = spaceFor(item, pr);
  if (overlay) closeOverlay(overlay);
  if (existing) return run("space.select", { id: existing.id });
  openOverlay({ mod: "new-worktree", kind: "dialog", width: 560, height: 780, props: {
    folder, machine, mode: pr ? "pr" : "issue",
    pick: { kind: pr ? "pr" : "issue", number: item.number, title: item.title, head: item.headRefName,
      ...(item.provider && item.provider !== "github" ? { provider: item.provider, url: item.url, state: item.state } : {}) },
  } });
}
