// Pull request parts of the viewer: checks, changed files with their diffs, linked issues.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, settings } from "herdr";

export const PR_DETAIL = "number,title,body,author,state,isDraft,labels,assignees,milestone,createdAt,updatedAt,comments,url,"
  + "baseRefName,headRefName,reviewRequests,latestReviews,statusCheckRollup,closingIssuesReferences,additions,deletions,"
  + "changedFiles,files,mergeStateStatus,reactionGroups";
export const COLOR = { pass: "#3fb950", fail: "#f85149", pending: "#d29922", merged: "#a371f7", draft: "#6e7681" };
export const MERGE = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };
const DIFF_LINES = 400;

// Check runs and commit statuses, as one list.
export function checks(i) {
  return (i.statusCheckRollup ?? []).map((c) => {
    const raw = String(c.conclusion || c.state || c.status || "").toUpperCase();
    const result = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(raw) ? "pass"
      : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(raw) ? "fail" : "pending";
    return { name: c.name ?? c.context ?? "Check", workflow: c.workflowName, result, raw, url: c.detailsUrl ?? c.targetUrl };
  });
}

export function checkSummary(list) {
  const n = (r) => list.filter((c) => c.result === r).length;
  return [[n("fail"), "failed"], [n("pending"), "pending"], [n("pass"), "passed"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(", ");
}

// GitHub's own links, plus "Closes #N" in the body (GitHub skips those when the base isn't the default branch).
export function linkedIssues(i, repo) {
  const out = new Map();
  for (const r of i.closingIssuesReferences ?? []) {
    const full = r.repository?.owner?.login ? `${r.repository.owner.login}/${r.repository.name}` : repo;
    out.set(`${full}#${r.number}`, { repo: full, number: r.number });
  }
  for (const m of (i.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi)) {
    const full = m[1] ?? repo;
    out.set(`${full}#${m[2]}`, { repo: full, number: Number(m[2]) });
  }
  return [...out.values()];
}

// The whole diff once per PR, split by file; only opened files draw it.
export function loadDiff(v, cx) {
  const id = v.id();
  if (v.diffs[id] !== undefined) return;
  v.diffs[id] = null;
  cx.spawn(async (cx) => {
    const r = await exec("gh", ["pr", "diff", String(v.number), "-R", v.repo], { on: v.machine }).catch((e) => ({ code: 1, stderr: String(e) }));
    const files = {};
    if (r.code === 0) for (const part of r.stdout.split(/^(?=diff --git )/m)) {
      const m = /^diff --git a\/.+? b\/(.+)$/m.exec(part);
      if (m) files[m[1]] = part;
    }
    v.diffs[id] = r.code === 0 ? { files } : { error: (r.stderr || r.stdout || "").trim() || "Could not load the diff" };
    cx.notify();
  });
}

function patch(text, t) {
  const lines = text.split("\n"), start = lines.findIndex((l) => l.startsWith("@@"));
  const note = (s) => div().px(12).py(10).text_size(12).text_color(t.muted).child(s);
  if (start < 0) return note(/Binary files/.test(text) ? "Binary file not shown" : "No content changes");
  const shown = lines.slice(start, start + DIFF_LINES), more = lines.length - start - shown.length;
  return v_flex().py(4).font_family(settings().font_family).text_size(12)
    .children(shown.map((l) => div().px(12).min_h(18)
      .when(l.startsWith("+"), (e) => e.bg(COLOR.pass + "26"))
      .when(l.startsWith("-"), (e) => e.bg(COLOR.fail + "26"))
      .when(l.startsWith("@@"), (e) => e.bg(t.raised).text_color(t.muted))
      .child(l || " ")))
    .when(more > 0, (e) => e.child(note(`${more} more lines · Open on GitHub to see all`)));
}

export function filesTab(v, i, t) {
  const d = v.diffs[v.id()], files = i.files ?? [];
  if (!files.length) return div().text_size(13).text_color(t.muted).child("No files changed.");
  return v_flex().gap(8)
    .children(files.map((f, n) => {
      const open = v.openFiles.has(f.path);
      return v_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
        .child(h_flex().id(`pr-file-${n}`).h(36).px(12).gap(8).items_center().bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (open) v.openFiles.delete(f.path); else { v.openFiles.add(f.path); loadDiff(v, cx); } cx.notify(); })
          .child(v.glyph(open ? "down" : "right", 14, t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_family(settings().font_family).child(f.path))
          .child(div().text_size(12).text_color(COLOR.pass).child(`+${f.additions}`))
          .child(div().text_size(12).text_color(COLOR.fail).child(`−${f.deletions}`)))
        .when(open, (e) => e.child(!d ? div().px(12).py(10).text_size(12).text_color(t.muted).child("Loading diff…")
          : d.error ? div().px(12).py(10).text_size(12).text_color(t.ansi1).child(d.error)
          : d.files[f.path] ? patch(d.files[f.path], t) : div().px(12).py(10).text_size(12).text_color(t.muted).child("No diff for this file")));
    }))
    .when((i.changedFiles ?? 0) > files.length, (e) => e.child(div().text_size(12).text_color(t.muted)
      .child(`Showing ${files.length} of ${i.changedFiles} files · Open on GitHub to see all`)));
}

export function checksTab(v, i, t) {
  const list = checks(i);
  if (!list.length) return v_flex().h(140).items_center().justify_center().gap(8).rounded(6).border_1().border_color(t.border)
    .child(v.glyph("pending", 20, t.muted)).child(div().text_size(13).text_color(t.muted).child("No checks reported yet"));
  return v_flex().rounded(6).border_1().border_color(t.border).overflow_hidden()
    .child(h_flex().h(40).px(14).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13).font_semibold().child(checkSummary(list)))
    .children(list.map((c, n) => h_flex().id(`pr-check-${n}`).min_h(44).px(14).py(6).gap(10).items_center().border_b(1).border_color(t.border)
      .when(Boolean(c.url), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.link(c.url, cx)))
      .child(v.glyph(c.result, 16, COLOR[c.result]))
      .child(v_flex().flex_1().min_w(0).child(div().text_size(13).font_medium().truncate().child(c.name))
        .when(Boolean(c.workflow), (e) => e.child(div().text_size(12).text_color(t.muted).truncate().child(c.workflow))))
      .child(div().text_size(12).text_color(t.muted).child(c.raw.toLowerCase().replace(/_/g, " ")))));
}
