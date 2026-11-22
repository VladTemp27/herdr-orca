import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, theme } from "herdr";
import { openUrl } from "./viewer.js";
import { startWorkspace } from "./start.js";

export class ExternalIssueViewer {
  constructor(issue, overlay) {
    this.issue = issue;
    this.overlay = overlay;
  }

  render() {
    const issue = this.issue, t = theme();
    const close = div().id("external-issue-close").size(32).flex().items_center().justify_center().rounded(8)
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => closeOverlay(this.overlay)).child("×");
    const status = issue.statusName || (issue.state === "CLOSED" ? "Closed" : "Open");
    const updated = issue.updatedAt ? new Date(issue.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    const body = issue.body?.trim() || "No description.";
    return v_flex().id("external-issue").size_full().min_h(0).rounded(12).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(48).flex_none().px(18).gap(10).items_center().border_b(1).border_color(t.border)
        .child(close)
        .child(div().font_semibold().child(issue.provider === "jira" ? "Jira issue" : "Linear issue"))
        .child(div().flex_1())
        .child(div().text_color(t.muted).font_family("JetBrains Mono").child(issue.number)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(24).py(20).gap(16)
        .child(div().text_size(22).font_semibold().child(issue.title))
        .child(h_flex().flex_wrap().gap(8).items_center().text_color(t.muted)
          .child(div().px(8).py(3).rounded(6).bg(t.raised).text_color(t.foreground).child(status))
          .when(Boolean(issue.issueType), (e) => e.child(div().px(8).py(3).rounded(6).bg(t.raised).child(issue.issueType)))
          .when(Boolean(issue.priority), (e) => e.child(div().px(8).py(3).rounded(6).bg(t.raised).child("Priority: " + issue.priority)))
          .when(Boolean(issue.assignees?.length), (e) => e.child(div().child("Assignee: " + issue.assignees.map((a) => a.login).join(", "))))
          .when(Boolean(issue.author?.login), (e) => e.child(div().child("Reporter: " + issue.author.login)))
          .when(Boolean(updated), (e) => e.child(div().child("Updated " + updated))))
        .child(h_flex().gap(6).children((issue.labels ?? []).map((label) => div().px(8).py(3).rounded(6).bg(t.raised).child(label.name))))
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Description"))
        .child(v_flex().id("external-issue-description").gap(9).text_size(14)
          .children(body.split(/\n{2,}/).map((paragraph, index) => div().id(`external-description-${index}`).child(paragraph)))))
      .child(h_flex().h(54).flex_none().px(18).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .child(div().id("external-issue-open").h(32).px(12).flex().items_center().rounded(8).cursor_pointer().bg(t.raised)
          .on_click(() => openUrl(issue.url)).child("Open in " + (issue.provider === "jira" ? "Jira" : "Linear")))
        .when(Boolean(issue.folder), (e) => e.child(div().id("external-issue-start").h(32).px(12).flex().items_center().rounded(8)
          .cursor_pointer().bg(t.foreground).text_color(t.background)
          .on_click(() => startWorkspace({ machine: issue.machine, folder: issue.folder, item: issue, pr: false, overlay: this.overlay }))
          .child("Start worktree"))));
  }
}
