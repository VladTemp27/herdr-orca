import { appHome, exec, openOverlay, readTextFile, window } from "herdr";
import { credentialTarget, normalizeSettings } from "./settings.js";

export async function issueSettings() {
  const path = appHome() + "/mods/issues/mod.json";
  const content = await readTextFile(path);
  let manifest = {};
  try { manifest = JSON.parse(content ?? "{}"); } catch {}
  return normalizeSettings(manifest.settings);
}

export async function issueToken(settings) {
  if (settings.provider === "github") return null;
  if (window().platform !== "macos") throw new Error("Jira and Linear credentials require macOS Keychain in this version.");
  const target = credentialTarget(settings);
  const result = await exec("security", ["find-generic-password", "-s", target.service, "-a", target.account, "-w"], { timeout: 10000 })
    .catch(() => null);
  return result?.code === 0 ? result.stdout.trim() : null;
}

export function connectIssueProvider(settings) {
  if (window().platform !== "macos") return false;
  openOverlay({ mod: "issues", kind: "dialog", width: 480, height: 280,
    props: { credential: settings } });
  return true;
}
