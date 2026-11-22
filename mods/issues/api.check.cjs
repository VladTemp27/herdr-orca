const assert = require("node:assert/strict");

(async () => {
  const { jiraCurrentUser, jiraIssues, linearIssues } = await import("./api.js");
  const settings = {
    jira: { baseUrl: "https://example.atlassian.net", email: "dev@example.com", projects: ["SOC"] },
    linear: { teams: ["ENG"] },
  };
  const calls = [];
  const jira = await jiraIssues(settings, "jira-secret", "timeout", false, async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ isLast: true, issues: [{
      key: "SOC-1", self: "https://example.atlassian.net/rest/api/3/issue/SOC-1",
      fields: { summary: "Timeout", status: { statusCategory: { key: "new" } } },
    }] }) };
  });
  assert.equal(new URL(calls[0][0]).pathname, "/rest/api/3/search/jql");
  assert.equal(new URL(calls[0][0]).searchParams.get("jql"), 'project in ("SOC") AND text ~ "timeout" ORDER BY updated DESC');
  assert.equal(calls[0][1].headers.Authorization, "Basic " + btoa("dev@example.com:jira-secret"));
  assert.equal(jira[0].number, "SOC-1");
  const fields = new URL(calls[0][0]).searchParams.get("fields").split(",");
  assert.ok(fields.includes("project"));
  assert.ok(fields.includes("priority"));
  assert.ok(fields.includes("issuetype"));

  const me = await jiraCurrentUser(settings, "jira-secret", async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ accountId: "user-1", displayName: "Developer" }) };
  });
  assert.equal(new URL(calls[1][0]).pathname, "/rest/api/3/myself");
  assert.equal(me.accountId, "user-1");

  const linear = await linearIssues(settings, "linear-secret", "retry", {
    status: "In Progress", assignee: "Dev", label: "bug",
  }, async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ data: { issues: { nodes: [{
      identifier: "ENG-1", title: "Retry", url: "https://linear.app/acme/issue/ENG-1",
      state: { name: "In Progress", type: "started" },
    }], pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  });
  const linearRequest = JSON.parse(calls[2][1].body);
  assert.equal(calls[2][0], "https://api.linear.app/graphql");
  assert.equal(calls[2][1].headers.Authorization, "linear-secret");
  assert.deepEqual(linearRequest.variables.filter.and.slice(0, 4), [
    { team: { key: { in: ["ENG"] } } },
    { state: { name: { eq: "In Progress" } } },
    { labels: { name: { eq: "bug" } } },
    { assignee: { name: { eq: "Dev" } } },
  ]);
  assert.equal(linear[0].number, "ENG-1");
  console.log("issue provider APIs: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
