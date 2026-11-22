const textOf = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (value.type === "hardBreak") return "\n";
  const content = (value.content ?? []).map(textOf).filter(Boolean);
  if (value.type === "doc") return content.join("\n\n");
  if (value.type === "paragraph" || value.type === "heading" || value.type === "codeBlock") return content.join("");
  if (value.type === "listItem") return "• " + content.join(" ");
  if (value.type === "bulletList") return content.join("\n");
  if (value.type === "orderedList") return content.map((item, index) => `${index + 1}. ${item.replace(/^• /, "")}`).join("\n");
  if (value.type === "blockquote") return content.join("\n").split("\n").map((line) => "> " + line).join("\n");
  if (value.type === "tableRow") return content.join(" | ");
  if (value.type === "tableCell" || value.type === "tableHeader") return content.join("");
  if (value.type === "table") return content.join("\n");
  return content.join("");
};

export function jiraFilterOptions(items) {
  const assignees = new Map();
  for (const assignee of items.flatMap((issue) => issue.assignees ?? [])) {
    const value = assignee.accountId ?? `name:${assignee.login}`;
    if (assignee.login) assignees.set(value, { value, label: assignee.login });
  }
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    assignees: [...assignees.values()].sort((a, b) => a.label.localeCompare(b.label)),
    statuses: unique(items.map((issue) => issue.statusName)),
    priorities: unique(items.map((issue) => issue.priority)),
    issueTypes: unique(items.map((issue) => issue.issueType)),
  };
}

export function filterJiraIssues(items, filters, currentUserId) {
  return items.filter((issue) => {
    const assignees = issue.assignees ?? [];
    if (filters.assignee === "me" && (!currentUserId || !assignees.some((person) => person.accountId === currentUserId))) return false;
    if (filters.assignee === "unassigned" && assignees.length) return false;
    if (filters.assignee && !["me", "all", "unassigned"].includes(filters.assignee) && !assignees.some((person) => (person.accountId ?? `name:${person.login}`) === filters.assignee)) return false;
    if (filters.status === "open" && issue.state !== "OPEN") return false;
    if (filters.status?.startsWith("status:") && issue.statusName !== filters.status.slice(7)) return false;
    if (filters.priority && issue.priority !== filters.priority) return false;
    if (filters.issueType && issue.issueType !== filters.issueType) return false;
    return true;
  });
}

export function jiraIssue(issue, baseUrl) {
  const fields = issue.fields ?? {};
  const status = fields.status?.statusCategory?.key;
  const assignee = fields.assignee;
  const reporter = fields.reporter;
  const host = baseUrl.replace(/\/+$/, "");
  return {
    provider: "jira",
    number: issue.key,
    projectKey: fields.project?.key,
    title: fields.summary ?? issue.key,
    body: textOf(fields.description),
    statusName: fields.status?.name ?? "",
    priority: fields.priority?.name ?? "",
    issueType: fields.issuetype?.name ?? "",
    state: status === "done" ? "CLOSED" : "OPEN",
    stateReason: status === "done" ? "COMPLETED" : null,
    author: reporter ? { login: reporter.displayName, avatar_url: reporter.avatarUrls?.["24x24"] } : null,
    assignees: assignee ? [{ login: assignee.displayName, accountId: assignee.accountId, avatar_url: assignee.avatarUrls?.["24x24"] }] : [],
    labels: (fields.labels ?? []).map((name) => ({ name })),
    createdAt: fields.created,
    updatedAt: fields.updated,
    url: issue.self ? issue.self.replace(/\/rest\/api\/3\/issue\/[^/]+$/, "/browse/" + issue.key) : host + "/browse/" + issue.key,
  };
}

export function linearIssue(issue) {
  const state = issue.state?.type;
  return {
    provider: "linear",
    number: issue.identifier,
    teamKey: issue.team?.key,
    title: issue.title,
    body: issue.description ?? "",
    state: state === "completed" || state === "canceled" ? "CLOSED" : "OPEN",
    stateReason: state === "canceled" ? "NOT_PLANNED" : state === "completed" ? "COMPLETED" : null,
    author: issue.creator ? { login: issue.creator.name, avatar_url: issue.creator.avatarUrl } : null,
    assignees: issue.assignee ? [{ login: issue.assignee.name, avatar_url: issue.assignee.avatarUrl }] : [],
    labels: (issue.labels?.nodes ?? []).map((label) => ({ name: label.name, color: label.color })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

export function jiraQuery(projects, query, advanced = false) {
  const scope = projects.length ? "project in (" + projects.map((key) => '"' + key.replaceAll('"', '\\"') + '"').join(",") + ")" : "";
  const search = query.trim();
  if (advanced) {
    const orderAt = search.search(/\bORDER\s+BY\b/i);
    const where = orderAt < 0 ? search : search.slice(0, orderAt).trim();
    const order = orderAt < 0 ? "" : search.slice(orderAt);
    const clauses = [scope, where && "(" + where + ")"].filter(Boolean).join(" AND ");
    return [clauses, order].filter(Boolean).join(" ");
  }
  const term = search ? 'text ~ "' + search.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"' : "";
  return [scope, term].filter(Boolean).join(" AND ") + " ORDER BY updated DESC";
}

export function linearIssueFilter(teamKeys, criteria = {}) {
  const and = [{ team: { key: { in: teamKeys } } }];
  if (criteria.status) and.push({ state: { name: { eq: criteria.status } } });
  if (criteria.label) and.push({ labels: { name: { eq: criteria.label } } });
  if (criteria.assignee) and.push({ assignee: { name: { eq: criteria.assignee } } });
  if (criteria.text?.trim()) and.push({ or: [
    { title: { containsIgnoreCase: criteria.text.trim() } },
    { description: { containsIgnoreCase: criteria.text.trim() } },
  ] });
  return { and };
}
