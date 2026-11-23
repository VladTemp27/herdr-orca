// The right-click menu, top to bottom. Edit this list to make it yours.
//
//   label  what the menu shows
//   icon   menu-<icon>.svg in this folder: square-pen, file-text, search, folder, files
//   app    a macOS app name: runs `open -a <app> <path>`; hidden when the app isn't installed
//   argv   or your own command: (path) => [program, ...args], run on this Mac without a shell
//   when   "file" or "dir" to show it for only one kind (default: both)
//   local  true: hidden for files on another machine (the command needs the file on this Mac).
//          App items are always local.
//   action built into the mod instead of a command: "new-file". Works on any machine and platform.
//
// More apps, for example:
//   { label: "Open in Zed", icon: "square-pen", app: "Zed" },
//   { label: "Open in Cursor", icon: "square-pen", app: "Cursor" },
//   { label: "Open in Xcode", icon: "square-pen", app: "Xcode", when: "file" },
//   { label: "Open with QuickMD", icon: "file-text", app: "QuickMD", when: "file" },
//   { label: "Open in Terminal", icon: "folder", app: "Terminal", when: "dir" },

import { exec } from "herdr";

export const ITEMS = [
  { label: "New file…", icon: "file-plus", action: "new-file" },
  { label: "Open in VS Code", icon: "square-pen", app: "Visual Studio Code" },
  { label: "Open in Preview", icon: "file-text", app: "Preview", when: "file" },
  { label: "Quick Look", icon: "search", argv: p => ["qlmanage", "-p", p], when: "file", local: true },
  { label: "Open with default app", icon: "file-text", argv: p => ["open", p], local: true },
  { label: "Reveal in Finder", icon: "folder", argv: p => ["open", "-R", p], local: true },
  { label: "Copy path", icon: "files", argv: p => ["sh", "-c", 'printf %s "$1" | pbcopy', "copy-path", p] },
];

// Shared key the menu sets to start an inline New file in the panel that opened it.
export const NEW_FILE = "files-open-with.new-file";

export function argvOf(item, path) {
  return item.app ? ["open", "-a", item.app, path] : item.argv(path);
}

// Popup height for n items: padding, the file name line, 31px rows.
export function menuHeight(n) {
  return 10 + 26 + n * 31 + 4;
}

// Which apps are installed, asked at most once a minute.
const APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "~/Applications", "/Applications/Setapp"];
const FIND = `for a in "$@"; do
  for d in ${APP_DIRS.map(d => (d.startsWith("~") ? `"$HOME${d.slice(1)}"` : `"${d}"`)).join(" ")}; do
    if [ -d "$d/$a.app" ]; then echo "$a"; continue 2; fi
  done
  q="kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '$a.app'"
  [ -n "$(mdfind "$q" 2>/dev/null | head -n 1)" ] && echo "$a"
done; true`;
let installed = null, checked = 0;

async function installedApps() {
  if (installed && Date.now() - checked < 60000) return installed;
  const apps = [...new Set(ITEMS.filter(it => it.app).map(it => it.app))];
  const r = await exec("sh", ["-c", FIND, "find-apps", ...apps]).catch(() => null);
  installed = new Set((r?.stdout ?? "").split("\n").filter(Boolean));
  checked = Date.now();
  return installed;
}

// Indexes into ITEMS that apply to this target ({ path, dir, on }). Off macOS only actions apply.
export async function available(target, mac = true) {
  const apps = mac ? await installedApps() : new Set();
  return ITEMS.map((it, i) => [it, i])
    .filter(([it]) => mac || it.action)
    .filter(([it]) => it.action || !it.when || it.when === (target.dir ? "dir" : "file"))
    .filter(([it]) => !(target.on && (it.local || it.app)))
    .filter(([it]) => !it.app || apps.has(it.app))
    .map(([, i]) => i);
}
