// Code colors for the panel preview and viewer tabs, from mod.json `settings.syntax`:
// "editor" (a soft editor palette), "terminal" (the theme's ANSI colors) or "off".
import { theme, settings } from "herdr";
import { prefs } from "./prefs.js";

const DARK = { keyword: "#c586c0", string: "#ce9178", comment: "#8b949e", punctuation: "#8b949e", function: "#dcdcaa", type: "#4ec9b0",
  number: "#b5cea8", constant: "#4fc1ff", boolean: "#569cd6", "string.escape": "#d7ba7d" };
const LIGHT = { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", punctuation: "#6e7781", function: "#8250df", type: "#953800",
  number: "#0550ae", constant: "#0550ae", boolean: "#0550ae", "string.escape": "#116329" };
// Comment markers (`//`, `/*`) are punctuation here, so the two share a color.
const TOKENS = ["keyword", "string", "comment", "punctuation", "function", "type", "number", "constant", "boolean", "string.escape"];

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", mdx: "markdown" };

// The highlighter's language for a file; env files (.env, .env.local, prod.env, .envrc) read as shell.
export function languageFor(path) {
  const name = path.split("/").pop().toLowerCase();
  if (/^\.env(\..+|rc)?$|\.env$/.test(name)) return "sh";
  const ext = name.includes(".") ? name.split(".").pop() : "txt";
  return LANG[ext] ?? ext;
}

const syntaxMode = () => prefs().then(s => s.syntax);

export async function syntaxColors() {
  const t = theme(), m = await syntaxMode();
  const plain = { variable: t.foreground, operator: t.foreground };
  return m === "off" ? { ...plain, ...Object.fromEntries(TOKENS.map(k => [k, t.foreground])) }
    : m === "terminal" ? { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, punctuation: t.dim }
    : { ...plain, ...(settings().dark ? DARK : LIGHT) };
}
