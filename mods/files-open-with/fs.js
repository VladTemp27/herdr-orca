// Creating and saving files, here or on another machine (`on`).
import { exec, readTextFile, writeTextFile, window } from "herdr";

// A command line carries the text to another machine; Linux caps one argument at 128 KiB.
const REMOTE_LIMIT = 40000;

const localWindows = on => !on && window()?.platform === "windows";

// Why a typed name can't be used, or null. Folders are allowed: src/new.ts.
export function nameProblem(name) {
  if (!name) return "Type a name";
  if (name.startsWith("/") || name.endsWith("/")) return "No leading or trailing /";
  if (name.split("/").some(s => s === "" || s === "." || s === "..")) return "No empty, . or .. parts";
  return null;
}

// Creates an empty file (and missing folders above it); fails if the path exists.
export async function createFile(path, on) {
  if (localWindows(on)) {
    if (await readTextFile(path) !== null) throw new Error("A file with that name already exists");
    return writeTextFile(path, "", null);
  }
  const script = '[ -e "$1" ] && { echo "A file or folder with that name already exists" >&2; exit 3; }; mkdir -p "$(dirname "$1")" && : > "$1"';
  const r = await exec("sh", ["-c", script, "new-file", path], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot create the file (exit ${r.code})`);
}

// Saves only if the file still holds `expected`, the text it was opened or last saved with.
export async function saveFile(path, text, expected, on) {
  if (!on) {
    try { return await writeTextFile(path, text, expected); }
    catch (e) { throw (await readTextFile(path).catch(() => null)) !== expected ? stale() : e; }
  }
  if (text.length > REMOTE_LIMIT) throw new Error("Too large to save on another machine from here");
  if ((await readTextFile(path, { on })) !== expected) throw stale();
  const r = await exec("sh", ["-c", 'printf %s "$2" > "$1"', "save", path, text], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot save (exit ${r.code})`);
}

function stale() {
  const e = new Error("The file changed on disk since you opened it");
  e.stale = true;
  return e;
}
