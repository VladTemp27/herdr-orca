import * as fs from "fs/promises";
import { appHome, exec } from "herdr";

// Herdr draws images only from real folders, and this mod's folder may be a
// symlink to its git checkout: icons and avatars go to its data folder instead.
const SVG = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  issue: SVG(`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`),
  refresh: SVG(`<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>`),
  done: SVG(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  skipped: SVG(`<circle cx="12" cy="12" r="10"/><line x1="9" x2="15" y1="15" y2="9"/>`),
  tag: SVG(`<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`),
  user: SVG(`<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`),
  pencil: SVG(`<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`),
  link: SVG(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  commit: SVG(`<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>`),
  milestone: SVG(`<path d="M12 13v8"/><path d="M12 3v3"/><path d="M18 6a2 2 0 0 1 1.387.56l2.307 2.22a1 1 0 0 1 0 1.44l-2.307 2.22A2 2 0 0 1 18 13H6a2 2 0 0 1-1.387-.56l-2.306-2.22a1 1 0 0 1 0-1.44l2.306-2.22A2 2 0 0 1 6 6z"/>`),
  pull: SVG(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`),
  external: SVG(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`),
  close: SVG(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  copy: SVG(`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`),
  back: SVG(`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`),
  // Table view (Orca-style list).
  plus: SVG(`<path d="M5 12h14"/><path d="M12 5v14"/>`),
  filter: SVG(`<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>`),
  search: SVG(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),
  chevron: SVG(`<path d="m6 9 6 6 6-6"/>`),
  updown: SVG(`<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`),
  arrow: SVG(`<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`),
  dots: SVG(`<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>`),
  left: SVG(`<path d="m15 18-6-6 6-6"/>`),
  right: SVG(`<path d="m9 18 6-6-6-6"/>`),
  merge: SVG(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`),
  "pull-closed": SVG(`<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v12M21 3l-6 6M15 3l6 6M18 13v2"/>`),
  draft: SVG(`<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v12M18 6v.01M18 11v.01"/>`),
  chat: SVG(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
  checks: SVG(`<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>`),
  file: SVG(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`),
  pass: SVG(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  fail: SVG(`<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>`),
  pending: SVG(`<circle cx="12" cy="12" r="10" stroke-dasharray="3 3"/>`),
  down: SVG(`<path d="m6 9 6 6 6-6"/>`),
  calendar: SVG(`<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>`),
  board: SVG(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>`),
  table: SVG(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>`),
  github: SVG(`<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>`),
};

let written = null;

// Resolves once the icons are on disk; draw them only after that.
export function icons() {
  written ??= (async () => {
    const dir = `${appHome()}/data/issues/icons`;
    await fs.mkdir(dir, { recursive: true });
    for (const [name, svg] of Object.entries(ICONS)) await fs.writeFile(`${dir}/${name}.svg`, svg);
  })();
  return written;
}

export const icon = (name) => `data/issues/icons/${name}.svg`;

// GitHub avatars, downloaded once per login into the data folder.
const avatars = {};
const file = (login) => `data/issues/avatars/${login.replace(/[^\w-]/g, "_")}.png`;

// The picture to draw, or null while there's none (yet).
export const avatarPath = (login) => avatars[login] === "ready" ? file(login) : null;

// Starts the download the first time a login is asked for: a promise that
// resolves true once its picture is ready. Bots without a URL have none.
export function loadAvatar(login, url) {
  if (avatars[login] !== undefined) return null;
  if (!url && /^app\/|\[bot\]$/.test(login)) { avatars[login] = "missing"; return null; }
  avatars[login] = "loading";
  return (async () => {
    const path = `${appHome()}/${file(login)}`;
    if (!await fs.exists(path)) {
      await fs.mkdir(`${appHome()}/data/issues/avatars`, { recursive: true });
      const r = await exec("curl", ["-sfL", "--max-time", "10", "-o", path, url ?? `https://github.com/${login}.png?size=80`]).catch(() => null);
      if (r?.code !== 0) { avatars[login] = "missing"; return false; }
    }
    avatars[login] = "ready";
    return true;
  })();
}
