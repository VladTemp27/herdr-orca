const PROVIDERS = new Set(["github", "jira", "linear"]);

const list = (value, pattern) => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => pattern.test(item)))];
};

const text = (value) => typeof value === "string" ? value.trim() : "";

function jiraBase(value) {
  const url = text(value).replace(/\/+$/, "");
  return /^https:\/\/[a-z\d.-]+(?:\/[^?#\s]*)?$/i.test(url) ? url : "";
}

export function normalizeSettings(raw = {}) {
  const jira = raw.jira ?? {};
  const linear = raw.linear ?? {};
  const filters = linear.filters ?? {};
  return {
    provider: PROVIDERS.has(raw.provider) ? raw.provider : "github",
    jira: {
      baseUrl: jiraBase(jira.baseUrl),
      email: text(jira.email),
      projects: list(jira.projects, /^[A-Za-z][A-Za-z0-9_]*$/),
    },
    linear: {
      teams: list(linear.teams, /^[A-Za-z0-9_-]+$/),
      filters: { status: text(filters.status), assignee: text(filters.assignee), label: text(filters.label) },
    },
  };
}

export function credentialTarget(settings) {
  if (settings.provider === "jira") {
    let host = "unconfigured";
    try { host = new URL(settings.jira.baseUrl).hostname; } catch {}
    return { service: "dev.herdr.orca.jira", account: host + ":" + settings.jira.email };
  }
  if (settings.provider === "linear") return { service: "dev.herdr.orca.linear", account: "default" };
  return null;
}
