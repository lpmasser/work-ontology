import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, chmod, writeFile, link } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { x as extract } from 'tar';

const updateConfig = JSON.parse(await readFile(new URL('./workbench-update.json', import.meta.url), 'utf8'));

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15',
  } }).trim();
}

export function checkAccess(url) {
  try { git(['ls-remote', '--exit-code', url, 'HEAD']); }
  catch (e) {
    throw new Error(`无法读取 ${url}。请检查网络、Git 凭据及仓库权限，然后重跑安装。\n${String(e.stderr || e.message).trim()}`);
  }
}

export async function ensureInfoHub(root, url) {
  checkAccess(url);
  if (existsSync(root)) {
    if (!existsSync(path.join(root, '.git')) || !existsSync(path.join(root, 'ontology/ontology.json'))) {
      throw new Error(`目录已存在且不是 InfoHub Git 副本：${root}；请选择 --root <目录>，不会覆盖已有内容。`);
    }
    console.log(`使用已有 InfoHub：${root}`);
    return;
  }
  await mkdir(path.dirname(root), { recursive: true });
  git(['clone', '--', url, root]);
  console.log(`已克隆 InfoHub：${root}`);
}

// Bootstrap only. Installed applications own all later upgrades through Tauri.
export function workbenchLocation(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') {
    const app = '/Applications/InfoHub Workbench.app';
    return { app, binary: path.join(app, 'Contents/MacOS/infohub-workbench') };
  }
  if (platform === 'win32') {
    const app = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'InfoHub Workbench');
    return { app, binary: path.join(app, 'infohub-workbench.exe') };
  }
  const app = path.join(home, '.local/share/infohub/workbench/InfoHubWorkbench.AppImage');
  return { app, binary: app };
}

export function updateTarget(platform = process.platform, arch = process.arch) {
  const target = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform];
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!target || !cpu || (platform !== 'darwin' && arch !== 'x64')) throw new Error(`尚无 ${platform}/${arch} 工作台包`);
  return `${target}-${cpu}`;
}

// Tauri's Minisign envelope; cryptographic primitives are Node/OpenSSL's
// Ed25519 and BLAKE2b. Both the payload and trusted comment must authenticate.
export function verifyWorkbenchArtifact(bytes, signature, pubkey = updateConfig.pubkey, expectedVersion) {
  try {
    const keyLines = Buffer.from(pubkey, 'base64').toString('utf8').trimEnd().split(/\r?\n/);
    const lines = Buffer.from(signature, 'base64').toString('utf8').trimEnd().split(/\r?\n/);
    const key = Buffer.from(keyLines[1] || '', 'base64');
    const sig = Buffer.from(lines[1] || '', 'base64');
    const global = Buffer.from(lines[3] || '', 'base64');
    const algorithm = sig.subarray(0, 2).toString();
    if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || sig.length !== 74
      || !['Ed', 'ED'].includes(algorithm) || global.length !== 64 || !lines[2]?.startsWith('trusted comment: ')
      || !key.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error('Invalid signature envelope');
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
    const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
    if (!verify(null, message, publicKey, sig.subarray(10))
      || !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice(17))]), publicKey, global)) throw new Error('Signature mismatch');
    if (expectedVersion !== undefined) {
      const version = lines[2].slice(17).split('\t').find(field => field.startsWith('version:'))?.slice(8);
      if (!version || version.replace(/^v/, '') !== expectedVersion.replace(/^v/, '')) throw new Error('Signed version mismatch');
    }
  } catch { throw new Error('工作台更新包签名无效，未执行安装'); }
}

export async function installWorkbench(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  const location = options.location || workbenchLocation(platform, home);
  const execute = options.execute || ((command, args) => execFileSync(command, args, { windowsHide: true, stdio: 'pipe', timeout: 600_000 }));
  if (existsSync(location.binary) || (platform === 'linux' && !options.location && existsSync('/usr/bin/infohub-workbench'))) {
    console.log('已找到工作台；接入安装器不执行升级，后续更新由工作台负责。');
    return 'existing';
  }
  if (existsSync(location.app)) throw new Error(`安装位置已存在但程序缺失，请先检查：${location.app}`);
  const fetcher = options.fetch || fetch;
  const get = async url => {
    if (new URL(url).protocol !== 'https:') throw new Error('工作台下载必须使用 HTTPS');
    const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`工作台下载失败：HTTP ${response.status}`);
    return response;
  };
  const latest = await (await get(updateConfig.endpoint)).json();
  const item = latest.platforms?.[updateTarget(platform, options.arch || process.arch)];
  if (typeof latest.version !== 'string' || typeof item?.url !== 'string' || typeof item?.signature !== 'string') throw new Error('工作台发布清单缺失或无效');
  const bytes = Buffer.from(await (await get(item.url)).arrayBuffer());
  verifyWorkbenchArtifact(bytes, item.signature, options.pubkey || updateConfig.pubkey, latest.version);
  const temp = await mkdtemp(path.join(tmpdir(), 'infohub-first-install-'));
  try {
    const file = path.join(temp, platform === 'darwin' ? 'workbench.app.tar.gz' : platform === 'win32' ? 'workbench.exe' : 'workbench.AppImage');
    await writeFile(file, bytes);
    if (platform === 'darwin') {
      const staging = await mkdtemp(path.join(path.dirname(location.app), '.infohub-install-'));
      try {
        await extract({ file, cwd: staging, strict: true, filter: name => name === 'InfoHub Workbench.app' || name.startsWith('InfoHub Workbench.app/') });
        const app = path.join(staging, 'InfoHub Workbench.app');
        if (!existsSync(path.join(app, 'Contents/MacOS/infohub-workbench'))) throw new Error('工作台归档缺少可执行文件');
        execute('codesign', ['--verify', '--deep', '--strict', app]);
        if (existsSync(location.app)) throw new Error('工作台已由其他安装操作创建，停止安装');
        await rename(app, location.app);
      } finally { await rm(staging, { recursive: true, force: true }); }
      execute('open', ['-a', location.app]);
    } else if (platform === 'win32') {
      execute(file, ['/S']);
      if (!existsSync(location.binary)) throw new Error('NSIS 安装结束后未找到工作台');
      execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${location.binary.replaceAll("'", "''")}' -ErrorAction Stop`]);
    } else {
      await mkdir(path.dirname(location.app), { recursive: true });
      if (existsSync(location.app)) throw new Error('工作台已由其他安装操作创建，停止安装');
      const staging = await mkdtemp(path.join(path.dirname(location.app), '.first-install-'));
      try {
        const prepared = path.join(staging, 'workbench.AppImage');
        await writeFile(prepared, bytes, { flag: 'wx', mode: 0o755 });
        await chmod(prepared, 0o755);
        // Same-filesystem link publishes complete bytes and refuses to replace
        // a concurrent install. Removing the staging link leaves the app intact.
        await link(prepared, location.app);
      } finally { await rm(staging, { recursive: true, force: true }); }
      const desktop = path.join(home, '.local/share/applications/de.eloyzh.infohub-workbench.desktop');
      await mkdir(path.dirname(desktop), { recursive: true });
      const quoted = location.app.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      await writeFile(desktop, `[Desktop Entry]\nType=Application\nName=InfoHub Workbench\nExec="${quoted}" --appimage-extract-and-run %F\nTerminal=false\nCategories=Office;\nMimeType=text/markdown;\n`);
      if (options.execute) execute(location.app, ['--appimage-extract-and-run']);
      else { await new Promise((resolve, reject) => { const child = spawn(location.app, ['--appimage-extract-and-run'], { detached: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); }); }
    }
    console.log(`工作台 ${latest.version} 已验证签名并首次安装`);
    return 'installed';
  } finally { await rm(temp, { recursive: true, force: true }); }
}
