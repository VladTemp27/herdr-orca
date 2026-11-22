const assert = require("node:assert/strict");

(async () => {
  const { jiraIssue, linearIssue, jiraQuery, linearIssueFilter, filterJiraIssues, jiraFilterOptions } = await import("./providers.js");

  const jira = jiraIssue({
    key: "SOC-42",
    fields: {
      summary: "Investigate timeout",
      description: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Observed " }, { type: "text", text: "timeout." }] },
        { type: "paragraph", content: [{ type: "text", text: "Next steps." }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Review logs" }] }] }] },
      ] },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { name: "High" },
      issuetype: { name: "Bug" },
      project: { key: "SOC" },
      reporter: { displayName: "Reporter" },
      assignee: { accountId: "user-1", displayName: "Owner" },
      labels: ["security"],
      updated: "2026-02-01T10:00:00.000Z",
    },
  }, "https://example.atlassian.net");
  assert.equal(jira.provider, "jira");
  assert.equal(jira.number, "SOC-42");
  assert.equal(jira.projectKey, "SOC");
  assert.equal(jira.title, "Investigate timeout");
  assert.equal(jira.body, "Observed timeout.\n\nNext steps.\n\n• Review logs");
  assert.equal(jira.state, "OPEN");
  assert.equal(jira.url, "https://example.atlassian.net/browse/SOC-42");
  assert.equal(jira.assignees[0].login, "Owner");
  assert.equal(jira.assignees[0].accountId, "user-1");
  assert.equal(jira.statusName, "In Progress");
  assert.equal(jira.priority, "High");
  assert.equal(jira.issueType, "Bug");
  assert.deepEqual(jira.labels.map((label) => label.name), ["security"]);

  const linear = linearIssue({
    identifier: "ENG-9",
    title: "Fix retry loop",
    description: "Retry gets stuck",
    url: "https://linear.app/acme/issue/ENG-9",
    updatedAt: "2026-02-02T10:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    team: { key: "ENG" },
    assignee: { name: "Owner" },
    labels: { nodes: [{ name: "bug" }] },
  });
  assert.equal(linear.provider, "linear");
  assert.equal(linear.number, "ENG-9");
  assert.equal(linear.teamKey, "ENG");
  assert.equal(linear.state, "OPEN");
  assert.equal(linear.url, "https://linear.app/acme/issue/ENG-9");

  assert.equal(jiraQuery(["SOC", "OPS"], "timeout", false),
    'project in ("SOC","OPS") AND text ~ "timeout" ORDER BY updated DESC');
  assert.equal(jiraQuery(["SOC"], 'status = "In Progress"', true),
    'project in ("SOC") AND (status = "In Progress")');
  assert.equal(jiraQuery(["SOC"], 'status = "In Progress" ORDER BY updated DESC', true),
    'project in ("SOC") AND (status = "In Progress") ORDER BY updated DESC');
  const filterItems = [
    { state: "OPEN", statusName: "Open", priority: "High", issueType: "Bug", assignees: [{ accountId: "me", login: "Me" }] },
    { state: "OPEN", statusName: "Open", priority: "Low", issueType: "Task", assignees: [{ accountId: "other", login: "Other" }] },
    { state: "CLOSED", statusName: "Done", priority: "High", issueType: "Bug", assignees: [] },
  ];
  assert.deepEqual(filterJiraIssues(filterItems, { assignee: "all", status: "open" }, "me"), filterItems.slice(0, 2));
  assert.deepEqual(filterJiraIssues(filterItems, { assignee: "me", status: "open" }, "me"), [filterItems[0]]);
  assert.deepEqual(filterJiraIssues(filterItems, { assignee: "unassigned", status: "all", priority: "High", issueType: "Bug" }, "me"), [filterItems[2]]);
  assert.deepEqual(jiraFilterOptions(filterItems), {
    assignees: [{ value: "me", label: "Me" }, { value: "other", label: "Other" }],
    statuses: ["Done", "Open"], priorities: ["High", "Low"], issueTypes: ["Bug", "Task"],
  });

  assert.deepEqual(linearIssueFilter(["ENG"], { status: "In Progress", label: "bug", assignee: "Owner" }), {
    and: [
      { team: { key: { in: ["ENG"] } } },
      { state: { name: { eq: "In Progress" } } },
      { labels: { name: { eq: "bug" } } },
      { assignee: { name: { eq: "Owner" } } },
    ],
  });
  console.log("issue providers: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
