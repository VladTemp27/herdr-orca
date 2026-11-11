const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
function load(file, extra = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class');
  const name = file.includes('panel') ? 'Panel' : 'Files';
  const c = { window: () => ({ platform: 'windows' }), View: class {}, ...extra };
  vm.createContext(c); vm.runInContext(`${source}\nthis.Test = ${name}; this.pathKey = pathKey;`, c); return c;
}
for (const file of ['mods/file-icons/main.js', 'mods/files-open-with/panel.js']) {
  const c = load(file);
  assert.notEqual(c.pathKey('/srv/Foo', 'linux-host'), c.pathKey('/srv/foo', 'linux-host'), file);
  assert.notEqual(c.pathKey('/srv/a\\b', 'linux-host'), c.pathKey('/srv/a/b', 'linux-host'), file);
  assert.equal(c.pathKey('C:\\Work\\Foo', null), c.pathKey('c:/work/foo', null), file);
}
const c = load('mods/files-open-with/panel.js');
const panel = new c.Test();
Object.assign(panel, { root: '/srv/repo', on: 'linux-host', ignored: new Set(['/srv/repo/Foo']) });
assert.equal(panel.isIgnored('Foo/child'), true);
assert.equal(panel.isIgnored('foo/child'), false);
Object.assign(panel, { root: 'C:\\Work\\Repo', on: null, ignored: new Set(['c:/work/repo/foo']) });
assert.equal(panel.isIgnored('Foo/child'), true);

const viewer = fs.readFileSync(path.join(root, 'mods/files-open-with/viewer.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class');
const v = { window: () => ({ platform: 'windows' }) }; vm.createContext(v);
vm.runInContext(`${viewer}\nthis.resolve = resolve; this.Viewer = Viewer;`, v);
assert.equal(v.resolve('/srv/a\\b/readme.md', 'Foo\\bar.md', 'linux-host'), '/srv/a\\b/Foo\\bar.md');
assert.equal(v.resolve('/srv/readme.md', 'C:local.md', 'linux-host'), '/srv/C:local.md');
assert.equal(v.resolve('C:\\Work\\readme.md', 'Foo\\bar.md', null), 'C:/Work/Foo/bar.md');
v.window = () => ({ platform: 'linux' });
assert.equal(v.resolve('/srv/a\\b/readme.md', '../x\\y.md', null), '/srv/x\\y.md');

let followed;
v.openFile = args => { followed = args; }; v.focused = () => ({ space: 'space' });
const remoteViewer = new v.Viewer(); Object.assign(remoteViewer, { file: '/srv/a\\b/readme.md', on: 'linux-host' });
remoteViewer.followLink('Foo\\bar.md', {});
assert.equal(followed.file, '/srv/a\\b/Foo\\bar.md');
const paneSource = fs.readFileSync(path.join(root, 'mods/my-pane/main.js'), 'utf8');
const pane = { window: () => ({ platform: 'windows' }), home: () => '/home/me' }; vm.createContext(pane);
vm.runInContext(paneSource.slice(paneSource.indexOf('function folder('), paneSource.indexOf('export default class')) + '\nthis.folder = folder;', pane);
assert.equal(pane.folder('/home/me\\literal', 'linux-host/terminal'), '/home/me\\literal');
pane.home = () => 'C:\\Users\\me';
assert.equal(pane.folder('C:\\Users\\me\\work', 'terminal'), '~\\work');
assert.ok(paneSource.includes('folder(p.cwd, p.terminal)'));
async function checkMarks(file, on) {
  const local = !on, cwd = local ? 'C:\\Work\\Repo' : '/srv/repo';
  const top = local ? 'c:/work/repo' : '/srv/repo';
  const seen = [], ui = () => {
    const proxy = new Proxy({}, { get: (_, name) => (...args) => {
      if (name === 'when' && args[0]) args[1](proxy);
      if (name === 'child' && ['M', 'A'].includes(args[0])) seen.push(args[0]);
      return proxy;
    } }); return proxy;
  };
  const c = load(file, { spaces: () => [{ active: true, folder: cwd, machine: on }], focused: () => ({}), panes: () => [],
    exec: async (_, args) => ({ code: 0, stdout: args.includes('--show-toplevel') ? top : ' M Foo\0?? foo\0!! Bar/\0' }),
    div: ui, h_flex: ui, svg: ui, image: ui, ICONS: { light: {}, fileNames: {}, fileExtensions: {}, folderNames: {}, file: 'file' } });
  const view = new c.Test(); Object.assign(view, { saved: new Map(), show() {}, watch() {}, loadFolder: async function() {
    this.entries.set('', [{ name: 'Foo', dir: false }, { name: 'foo', dir: false }]);
  } });
  const jobs = [], cx = { spawn: callback => jobs.push(callback(cx)), notify() {} };
  view.refresh(cx); await Promise.all(jobs);
  if (local) assert.equal(view.marks['c:/work/repo/foo'], 'A');
  else {
    assert.equal(view.marks['/srv/repo/Foo'], 'M'); assert.equal(view.marks['/srv/repo/foo'], 'A');
  }
  if (file.includes('panel')) {
    assert.equal(view.isIgnored('Bar/child'), true); assert.equal(view.isIgnored('bar/child'), local);
  }
  view.rows('', 0, [], {}, true);
  assert.deepEqual(seen, local ? ['A', 'A'] : ['M', 'A']);
}
(async () => {
  for (const file of ['mods/file-icons/main.js', 'mods/files-open-with/panel.js']) {
    await checkMarks(file, 'linux-host'); await checkMarks(file, null);
  }
  console.log('target path tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
