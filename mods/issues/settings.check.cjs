const assert = require("node:assert/strict");

(async () => {
  const { normalizeSettings, credentialTarget } = await import("./settings.js");
  assert.deepEqual(normalizeSettings(), {
    provider: "github",
    jira: { baseUrl: "", email: "", projects: [] },
    linear: { teams: [], filters: { status: "", assignee: "", label: "" } },
  });
  assert.deepEqual(normalizeSettings({
    provider: "jira",
    jira: { baseUrl: " https://acme.atlassian.net/ ", email: " dev@example.com ", projects: [" SOC ", "OPS", "x; DELETE"] },
    linear: { teams: ["ENG"] },
  }), {
    provider: "jira",
    jira: { baseUrl: "https://acme.atlassian.net", email: "dev@example.com", projects: ["SOC", "OPS"] },
    linear: { teams: ["ENG"], filters: { status: "", assignee: "", label: "" } },
  });
  assert.equal(normalizeSettings({ provider: "unknown", jira: { baseUrl: "http://evil.test" } }).provider, "github");
  assert.equal(normalizeSettings({ jira: { baseUrl: "http://evil.test" } }).jira.baseUrl, "");
  assert.deepEqual(credentialTarget(normalizeSettings({
    provider: "jira", jira: { baseUrl: "https://acme.atlassian.net", email: "dev@example.com" },
  })), {
    service: "dev.herdr.orca.jira",
    account: "acme.atlassian.net:dev@example.com",
  });
  assert.deepEqual(credentialTarget(normalizeSettings({ provider: "linear" })), {
    service: "dev.herdr.orca.linear",
    account: "default",
  });
  console.log("issue settings: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
