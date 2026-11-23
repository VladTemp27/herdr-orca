// This mod's settings (mod.json `settings`, edited in Herdr's Mod settings), read once per load;
// Herdr reloads the mod when mod.json is saved.
import { loadSettings } from "./settings.js";

const DEFAULTS = { syntax: "editor", auto_save: true };
let loaded = null;

export function prefs() {
  loaded ??= loadSettings("files-open-with", DEFAULTS).then(({ settings: s, problems }) => {
    for (const p of problems) console.warn(`files-open-with mod.json settings: ${p}`);
    return s;
  });
  return loaded;
}
