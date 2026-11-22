import { jiraIssue, linearIssue, jiraQuery, linearIssueFilter } from "./providers.js";

const LIMIT = 200;
const JIRA_FIELDS = "summary,description,status,reporter,assignee,labels,created,updated,project,priority,issuetype";

async function json(response, service) {
  if (!response.ok) throw new Error(service + " request failed (" + response.status + ")");
  return response.json();
}

function jiraAuth(settings, token) {
  return "Basic " + btoa(settings.jira.email + ":" + token);
}

export async function jiraCurrentUser(settings, token, fetcher = fetch) {
  if (!settings.jira.baseUrl || !settings.jira.projects.length) throw new Error("Configure a Jira site and at least one project in Mod settings.");
  if (!settings.jira.email || !token) throw new Error("Connect Jira with an API token in the Keychain.");
  const response = await fetcher(settings.jira.baseUrl + "/rest/api/3/myself", {
    headers: { Accept: "application/json", Authorization: jiraAuth(settings, token) },
  });
  const user = await json(response, "Jira");
  if (!user.accountId) throw new Error("Jira did not return the current user.");
  return { accountId: user.accountId, displayName: user.displayName };
}

export async function jiraIssues(settings, token, query, advanced = false, fetcher = fetch) {
  if (!settings.jira.baseUrl || !settings.jira.projects.length) throw new Error("Configure a Jira site and at least one project in Mod settings.");
  if (!settings.jira.email || !token) throw new Error("Connect Jira with an API token in the Keychain.");
  const items = [];
  let nextPageToken;
  for (let page = 0; page < LIMIT / 100; page++) {
    const params = new URLSearchParams({
      jql: jiraQuery(settings.jira.projects, query, advanced),
      fields: JIRA_FIELDS,
      maxResults: "100",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const response = await fetcher(settings.jira.baseUrl + "/rest/api/3/search/jql?" + params, {
      headers: { Accept: "application/json", Authorization: jiraAuth(settings, token) },
    });
    const data = await json(response, "Jira");
    items.push(...(data.issues ?? []).map((issue) => jiraIssue(issue, settings.jira.baseUrl)));
    nextPageToken = data.nextPageToken;
    if (data.isLast || !nextPageToken || items.length >= LIMIT) break;
  }
  return items.slice(0, LIMIT);
}

const LINEAR_QUERY = "query Issues($filter: IssueFilter!, $after: String) { issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) { nodes { identifier title description url createdAt updatedAt state { name type } team { key } creator { name avatarUrl } assignee { name avatarUrl } labels { nodes { name color } } } pageInfo { hasNextPage endCursor } } }";

export async function linearIssues(settings, token, query, filters = {}, fetcher = fetch) {
  if (!settings.linear.teams.length) throw new Error("Configure at least one Linear team in Mod settings.");
  if (!token) throw new Error("Connect Linear with an API key in the Keychain.");
  const items = [];
  let after = null;
  for (let page = 0; page < LIMIT / 100; page++) {
    const response = await fetcher("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter: linearIssueFilter(settings.linear.teams, { ...filters, text: query }), after } }),
    });
    const data = await json(response, "Linear");
    if (data.errors?.length) throw new Error("Linear rejected the issue query.");
    const connection = data.data?.issues;
    if (!connection) throw new Error("Linear returned no issues.");
    items.push(...connection.nodes.map(linearIssue));
    after = connection.pageInfo?.endCursor ?? null;
    if (!connection.pageInfo?.hasNextPage || !after || items.length >= LIMIT) break;
  }
  return items.slice(0, LIMIT);
}
