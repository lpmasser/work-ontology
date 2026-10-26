import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { c as archive } from 'tar';
import { installWorkbench, updateTarget, verifyWorkbenchArtifact } from './install-source.mjs';

const envelope = value => Buffer.from(value).toString('base64');
// Public interoperability vectors from jedisct1/rust-minisign-verify (ISC).
const publicVector = envelope('untrusted comment: public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3');
const signatureVector = envelope('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==');
test('bootstrap authenticates the official Minisign vector and rejects modified content or trusted comments', () => {
  verifyWorkbenchArtifact(Buffer.from('test'), signatureVector, publicVector);
  assert.throws(() => verifyWorkbenchArtifact(Buffer.from('Test'), signatureVector, publicVector), /签名无效/);
  const changed = envelope(Buffer.from(signatureVector, 'base64').toString().replace('file:test', 'file:other'));
  assert.throws(() => verifyWorkbenchArtifact(Buffer.from('test'), changed, publicVector), /签名无效/);
});

function signed(bytes) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = Buffer.alloc(8, 7);
  const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  const raw = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
  const comment = 'timestamp:1\tfile:fixture\tversion:0.5.0';
  const global = sign(null, Buffer.concat([raw, Buffer.from(comment)]), privateKey);
  return { pubkey: envelope('untrusted comment: fixture\n' + key.toString('base64')),
    signature: envelope('untrusted comment: fixture\n' + Buffer.concat([Buffer.from('ED'), id, raw]).toString('base64') + '\ntrusted comment: ' + comment + '\n' + global.toString('base64')) };
}
async function fixture(t, platform) {
  const root = await mkdtemp(path.join(tmpdir(), 'infohub-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'installed', platform === 'linux' ? 'InfoHubWorkbench.AppImage' : 'InfoHub Workbench.app');
  const binary = platform === 'linux' ? app : path.join(app, platform === 'darwin' ? 'Contents/MacOS/infohub-workbench' : 'infohub-workbench.exe');
  await mkdir(path.dirname(app));
  let bytes = Buffer.from('bootstrap payload');
  if (platform === 'darwin') {
    const source = path.join(root, 'archive');
    const executable = path.join(source, 'InfoHub Workbench.app/Contents/MacOS/infohub-workbench');
    await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, bytes, { mode: 0o755 });
    const file = path.join(root, 'app.tar.gz'); await archive({ cwd: source, file, gzip: true }, ['InfoHub Workbench.app']); bytes = await readFile(file);
  }
  const auth = signed(bytes); let gets = 0; const commands = [];
  const options = { platform, arch: 'x64', home: root, location: { app, binary }, pubkey: auth.pubkey,
    fetch: async url => { gets++; return url.endsWith('latest.json') ? Response.json({ version: '0.5.0', platforms: { [updateTarget(platform, 'x64')]: { url: 'https://updates.test/package', signature: auth.signature } } }) : new Response(bytes); },
    execute(command, args) { commands.push([command,args]); if (platform === 'win32' && args.includes('/S')) { mkdirSync(app, { recursive: true }); writeFileSync(binary, 'installed'); } },
  };
  return { root, options, commands, binary, auth, get count() { return gets; } };
}

test('fresh macOS, Windows and Linux installs verify before launching; subsequent runs do no network IO or native commands', async t => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const f = await fixture(t, platform);
    assert.equal(await installWorkbench(f.options), 'installed');
    assert.ok((await stat(f.binary)).isFile());
    if (platform === 'darwin') assert.deepEqual(f.commands.map(c => c[0]), ['codesign', 'open']);
    if (platform === 'win32') assert.ok(f.commands[0][1].includes('/S'));
    // POSIX mode bits are not represented by the Windows filesystem API.
    if (platform === 'linux' && process.platform !== 'win32') assert.equal((await stat(f.binary)).mode & 0o777, 0o755);
    const original = await readFile(f.binary); const count = f.count; const commands = f.commands.length;
    assert.equal(await installWorkbench({ ...f.options, fetch() { assert.fail('existing app must not query releases'); } }), 'existing');
    assert.deepEqual(await readFile(f.binary), original); assert.equal(f.count, count); assert.equal(f.commands.length, commands);
  }
});

test('a damaged signature never reaches any platform installer', async t => {
  for (const platform of ['darwin','win32','linux']) {
    const f = await fixture(t, platform);
    const wrong = signed(Buffer.from('different payload'));
    await assert.rejects(installWorkbench({ ...f.options, pubkey: wrong.pubkey }), /签名无效/);
    assert.equal(f.commands.length, 0); await assert.rejects(stat(f.binary), { code: 'ENOENT' });
  }
});


test('a manifest cannot relabel an older signed package as a newer version', async t => {
  const f = await fixture(t, 'linux');
  const get = f.options.fetch;
  await assert.rejects(installWorkbench({ ...f.options, fetch: async url => {
    const response = await get(url);
    if (!url.endsWith('latest.json')) return response;
    const data = await response.json(); data.version = '9.9.9'; return Response.json(data);
  } }), /签名无效/);
  assert.equal(f.commands.length, 0);
});
