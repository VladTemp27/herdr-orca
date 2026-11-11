const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const git = fs.readFileSync(path.join(root, 'mods/new-worktree/git.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'mods/new-worktree/main.js'), 'utf8');
const helpers = git.split('\n').filter(l => /^export const (norm|tilde) =/.test(l)).join('\n').replaceAll('export ', '');
const open = main.slice(main.indexOf('  async open(path, cx) {'), main.indexOf('\n  task(agent) {'));
async function check(on, existing, target, setup = false) {
  const calls = []; let reads = 0;
  const c = { window: () => ({ platform: 'windows' }), localStorage: { setItem() {} },
    spaces: () => [{ id: 'existing', machine: on, folder: setup && !reads ? '/other' : existing, tabs: reads++ ? [{ id: 'agent' }] : [] }],
    place: s => s.folder, run: (action, args) => calls.push({ action, args }),
    hookEnv: () => [], shProgram: async () => 'sh', notify() {} };
  vm.createContext(c); vm.runInContext(`${helpers}\nclass Test {${open}}; this.Test = Test; this.norm = norm; this.tilde = tilde;`, c);
  const view = new c.Test();
  Object.assign(view, { name: { value: () => '' }, agent: 'claude', agents: [{ name: 'claude', run: ['claude'] }], on,
    task: () => null, setupScript: setup ? 'true' : null, runSetup: setup, own: () => ({ setupWait: false }), project: { main: '/repo' } });
  await view.open(target, { sleep: async () => {} });
  return { calls, norm: c.norm, tilde: c.tilde };
}
(async () => {
  for (const [existing, target] of [['/srv/App', '/srv/app'], ['/srv/a\\b', '/srv/a/b']]) {
    const { calls } = await check('linux-host', existing, target);
    assert.equal(calls[0].action, 'space.new', 'remote paths must remain distinct');
    const setup = await check('linux-host', existing, target, true);
    assert.ok(!setup.calls.some(c => c.action === 'tab.new'), 'setup cannot attach to a different remote folder');
  }
  const local = await check(null, 'C:\\Work\\Repo', 'c:/work/repo');
  assert.equal(local.calls[0].action, 'space.select');
  assert.equal(local.norm('/srv/a\\B', 'linux-host'), '/srv/a\\B');
  assert.equal(local.tilde('/HOME/me/x', '/home/me', 'linux-host'), '/HOME/me/x');
  assert.equal(local.tilde('C:\\Users\\me/x', 'c:/users/me', null), '~/x');
  const setup = await check(null, 'C:\\Work\\Repo', 'c:/work/repo', true);
  assert.ok(setup.calls.some(c => c.action === 'tab.new'));
  const child = await check(null, 'C:\\Work\\Repo/sub', 'c:/work/repo');
  assert.equal(child.calls[0].action, 'space.select');
  console.log('target path tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
