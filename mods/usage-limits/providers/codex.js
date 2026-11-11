// Codex: `codex app-server` → account/rateLimits/read (helpers/codex-limits.sh),
// or the newest snapshot Codex logged, printed as {"snapshot": <line>}.
import { makeWindow, okReport, errorReport, toEpoch, jsonLines } from "../lib/report.js";

const LONG = { 300: "5-hour", 10080: "Weekly" };
const SHORT = { 300: "5h", 10080: "wk" };

function slotWindows(limitId, limitName, slots) {
  const prefix = limitId === "codex" ? null : (limitName || limitId);
  const out = [];
  for (const [slot, w] of slots) {
    if (!w || w.usedPercent == null) continue;
    const mins = Number(w.windowDurationMins) || null;
    const short = SHORT[mins] ?? (mins ? `${Math.round(mins / 60)}h` : slot);
    const long = LONG[mins] ?? (mins ? `${Math.round(mins / 60)}-hour` : slot);
    out.push(makeWindow({
      id: `${limitId}:${slot}`,
      short: prefix ? `${prefix} ${short}` : short,
      long: prefix ? `${prefix} · ${long}` : long,
      percent: w.usedPercent,
      resetsAt: toEpoch(w.resetsAt),
      durationSec: mins ? mins * 60 : null,
    }));
  }
  return out;
}

// Free rate-limit resets. No count means Codex didn't report them, which is not the same as 0.
function resetCredits(c) {
  if (!Number.isFinite(c?.availableCount)) return null;
  const expiries = (c.credits ?? [])
    .filter((x) => x.status?.toLowerCase() === "available")
    .map((x) => toEpoch(x.expiresAt))
    .filter((at) => at != null);
  return {
    count: Math.max(0, Math.floor(c.availableCount)),
    nextExpiresAt: toEpoch(c.nextExpiresAt) ?? (expiries.length ? Math.min(...expiries) : null),
  };
}

function fromRpc(result, now) {
  const byId = result.rateLimitsByLimitId ?? (result.rateLimits ? { [result.rateLimits.limitId ?? "codex"]: result.rateLimits } : {});
  const ids = Object.keys(byId).sort((a, b) => (a === "codex" ? -1 : b === "codex" ? 1 : 0));
  const windows = ids.flatMap((id) => {
    const r = byId[id];
    return slotWindows(id, r.limitName, [["primary", r.primary], ["secondary", r.secondary]]);
  });
  const plan = result.rateLimits?.planType ?? byId[ids[0]]?.planType ?? null;
  if (!windows.length) return errorReport("codex app-server", "No limits in Codex reply", now);
  return { ...okReport("codex app-server", now, windows, plan), resets: resetCredits(result.rateLimitResetCredits) };
}

// A logged snapshot is never a live reading: the provider is failing, and the
// snapshot is only a dated candidate for "last good" (see lib/state.js).
function fromSnapshot(snap, now) {
  const failed = errorReport("codex app-server", "Codex app-server didn't answer", now);
  const at = toEpoch(snap.timestamp);
  const r = snap.payload?.rate_limits ?? {};
  const camel = (w) => w && { usedPercent: w.used_percent, windowDurationMins: w.window_minutes, resetsAt: w.resets_at };
  const windows = slotWindows(r.limit_id ?? "codex", r.limit_name, [["primary", camel(r.primary)], ["secondary", camel(r.secondary)]]);
  if (at == null || !windows.length) return failed;
  return { ...failed, fallback: okReport("Codex session log", now, windows, r.plan_type ?? null, at) };
}

export function parse(text, now) {
  for (const m of jsonLines(text)) {
    if (m.id === 2 && m.result) return fromRpc(m.result, now);
    if (m.id === 2 && m.error) return errorReport("codex app-server", String(m.error.message ?? "Codex error"), now);
    if (m.snapshot) return fromSnapshot(m.snapshot, now);
  }
  return errorReport("codex app-server", "No reply from Codex", now);
}

const OUTCOMES = {
  reset: { ok: true, message: "Your limits are reset." },
  alreadyRedeemed: { ok: true, message: "Your limits are reset." },
  nothingToReset: { ok: false, message: "No Codex limit can be reset right now." },
  noCredit: { ok: false, message: "You have no resets left." },
};

// helpers/codex-reset.sh's answer. settled: false means a credit may or may not have
// been spent, so the next try has to reuse the same key.
export function parseReset(text) {
  const m = jsonLines(text).find((line) => line.id === 2);
  const known = OUTCOMES[m?.result?.outcome];
  if (known) return { ...known, settled: true };
  return { ok: false, settled: false, message: String(m?.error?.message ?? "No answer from Codex. Trying again won't use a second reset.") };
}

export default {
  id: "codex",
  name: "Codex",
  icon: "icons/codex.svg",
  helper: "helpers/codex-limits.sh",
  parse,
  reset: { helper: "helpers/codex-reset.sh", parse: parseReset },
};
