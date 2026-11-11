// Project icons, ported from the paddock mod: its "Set icon…" pick, else the GitHub
// owner's avatar, else a logo in the repo. Shares paddock's cache in data/paddock-icons.
import { exec, appHome, shared, window } from "herdr";
import { writeFile, unlink } from "fs/promises";
import { shProgram, unix } from "./sh.js";

const DATA_DIR = "data/paddock-icons";
const TYPES = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const TYPE_OF = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const isJpeg = (type) => type === "jpg" || type === "jpeg";
const savedType = (type) => (isJpeg(type) ? "png" : type);
const hashText = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

function iconType(path) {
  const name = String(path ?? "").split("/").pop();
  const dot = name.lastIndexOf(".");
  const type = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return TYPES.includes(type) ? type : null;
}

// The icon picked in paddock for the project at `root`, if any.
export function pickedIcon(machine, root) {
  const m = machine ?? "";
  const project = (shared("paddock.projects")?.[m]?.list ?? []).find((p) => p.root === root);
  return project ? ((shared("paddock.icons") ?? {})[`${m}:${project.id}`] ?? null) : null;
}

// A PowerShell string literal (it also takes curly quotes as quotes).
const psq = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;

// image() draws no JPEG in this build, so those become PNGs. Windows: System.Drawing,
// never `convert` (that name is System32's FAT-to-NTFS disk converter there).
async function place(src, dest, type) {
  const platform = window().platform;
  const r = !isJpeg(type)
    ? await unix("cp", ["--", src, dest])
    : platform === "macos"
      ? await exec("sips", ["-s", "format", "png", src, "--out", dest])
      : platform === "windows"
        ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -AssemblyName System.Drawing; $i = [Drawing.Image]::FromFile(${psq(src)}); try { $i.Save(${psq(dest)}, [Drawing.Imaging.ImageFormat]::Png) } finally { $i.Dispose() }`])
        : await exec("convert", [src, `png:${dest}`]).catch(() => ({ code: 1, stderr: "needs ImageMagick" }));
  return r.code === 0 ? null : (r.stderr || r.stdout || "failed").trim();
}

async function githubAvatar(root, machine) {
  const r = await exec("git", ["-C", root, "remote", "get-url", "origin"], machine ? { on: machine } : {});
  const owner = r.code === 0 && /github\.com[:/]+([^/]+)\//i.exec(r.stdout.trim())?.[1];
  if (!owner) return null;
  const dir = `${appHome()}/${DATA_DIR}/github`;
  const name = safe(owner);
  // The pattern stays inside the script: Git's sh on Windows would glob a `*` argument.
  const fresh = await exec(await shProgram(), ["-c", 'find "$1" -maxdepth 1 -name "$2.*" -mtime -1', "sh", dir, name]).catch(() => null);
  const have = fresh?.stdout.trim().split("\n").find((f) => iconType(f));
  if (have) return `${DATA_DIR}/github/${have.split("/").pop()}`;
  await unix("mkdir", ["-p", dir]);
  const tmp = `${dir}/${name}.download`;
  const d = await exec("curl", [
    "-fsSL", "--max-time", "10", "-o", tmp, "-w", "%{content_type}",
    `https://github.com/${owner}.png?size=96`,
  ]);
  const type = TYPE_OF[d.stdout.trim().split(";")[0].toLowerCase()];
  if (d.code !== 0 || !type) {
    await unix("rm", ["-f", "--", tmp]);
    throw new Error("avatar download failed");
  }
  await exec(await shProgram(), ["-c", 'for t in png jpg gif webp svg; do rm -f -- "$1.$t"; done', "sh", `${dir}/${name}`]);
  const failed = await place(tmp, `${dir}/${name}.${savedType(type)}`, type);
  await unix("rm", ["-f", "--", tmp]);
  if (failed) throw new Error(failed);
  return `${DATA_DIR}/github/${name}.${savedType(type)}`;
}

const CANDIDATES = [
  ".github/logo.svg", ".github/logo.png", "logo.svg", "logo.png", "icon.svg", "icon.png",
  "assets/logo.svg", "assets/logo.png", "assets/icon.svg", "assets/icon.png",
  "app/icon.svg", "app/icon.png", "src/app/icon.svg", "src/app/icon.png",
  "public/logo.svg", "public/logo.png", "public/icon.svg", "public/icon.png",
  "public/favicon.svg", "public/favicon.png", "public/apple-touch-icon.png",
  "static/favicon.svg", "static/favicon.png", "docs/logo.svg", "docs/logo.png",
  "build/icon.png", "resources/icon.png", "favicon.svg", "favicon.png",
];
const FIND = `cd "$1" 2>/dev/null || exit 0
pick() { printf '%s\\n' "$1"; cksum < "$1" | cut -d' ' -f1; exit 0; }
for f in ${CANDIDATES.join(" ")}; do [ -f "$f" ] && pick "$f"; done
f=$(git ls-files 2>/dev/null | grep -v node_modules | grep -iE '(^|/)(logo|icon|favicon|app-icon|apple-touch-icon|logomark)\\.(svg|png|jpe?g|gif|webp)$' | awk -F/ '{print NF"\\t"$0}' | sort -n | head -1 | cut -f2-)
[ -n "$f" ] && [ -f "$f" ] && pick "$f"; true`;

async function repoFileIcon(root, machine) {
  const r = await exec(await shProgram(machine), ["-c", FIND, "sh", root], machine ? { on: machine } : {});
  const [file, sum] = r.stdout.trim().split("\n");
  if (r.code !== 0 || !file || !sum || !iconType(file)) return null;
  const type = iconType(file);
  const rel = `${DATA_DIR}/repo/${safe(machine ?? "local")}-${hashText(root)}-${sum}.${savedType(type)}`;
  const dest = `${appHome()}/${rel}`;
  if ((await unix("test", ["-f", dest])).code === 0) return rel;
  await unix("mkdir", ["-p", `${appHome()}/${DATA_DIR}/repo`]);
  const src = `${root}/${file}`;
  if (!machine) return (await place(src, dest, type)) ? null : rel;
  const b = await exec("sh", ["-c", 'base64 < "$1"', "sh", src], { on: machine });
  if (b.code !== 0) return null;
  const tmp = `${dest}.b64`;
  const raw = `${dest}.src`;
  await writeFile(tmp, b.stdout);
  const ok =
    (await exec(await shProgram(), ["-c", 'base64 -d < "$1" > "$2"', "sh", tmp, raw])).code === 0 &&
    !(await place(raw, dest, type));
  await unlink(tmp).catch(() => {});
  await unlink(raw).catch(() => {});
  return ok ? rel : null;
}

// A repo's default icon, as a path relative to the app folder, or null.
export async function findRepoIcon(root, machine) {
  return (await githubAvatar(root, machine)) ?? (await repoFileIcon(root, machine));
}
