import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { status } from '../sync/command.mjs';
import { etag } from './web-files.mjs';

export class WorkspaceEvents {
  constructor(files, sessions, intervalMs = 30000) {
    this.files = files; this.sessions = sessions; this.intervalMs = intervalMs;
    this.clients = new Map(); this.versions = new Map(); this.stats = new Map(); this.serial = 0; this.boot = randomUUID();
  }
  async start() {
    await this.scan();
    try {
      this.watcher = watch(this.files.root, { recursive: true }, (_event, filename) => {
        const name = filename?.toString().replaceAll('\\', '/');
        if (name?.split('/').some(part => part.startsWith('.'))) {
          if (name.startsWith('.git/infohub-sync/')) {
            clearTimeout(this.statusDebounce);
            this.statusDebounce = setTimeout(() => this.refreshStatus().catch(() => {}), 75);
          }
          return;
        }
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan().catch(() => {}), 75);
      });
      this.watcher.on('error', () => { this.watcher.close(); });
    } catch { /* Periodic stat scans cover systems without recursive watch. */ }
    this.timer = setInterval(() => this.scan().catch(() => {}), this.intervalMs);
    // Status is a small filesystem projection, independent of content scans.
    this.statusTimer = setInterval(() => this.refreshStatus().catch(() => {}), 2000);
    this.heartbeat = setInterval(() => {
      for (const [res, req] of this.clients) {
        if (!this.sessions.get(req)) res.end(); else res.write(': heartbeat\n\n');
      }
    }, 15000);
  }
  send(res, type, payload) {
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`id: ${this.boot}:${++this.serial}\nevent: ${type}\ndata: ${JSON.stringify({ version: 1, ...payload })}\n\n`);
  }
  emit(type, payload) {
    for (const [res, req] of this.clients) {
      if (!this.sessions.get(req)) res.end(); else this.send(res, type, payload);
    }
  }
  subscribe(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    this.clients.set(res, req);
    res.on('close', () => this.clients.delete(res));
    this.send(res, 'ready', { source: 'workspace', reset: true });
    this.send(res, 'sync', { status: this.lastStatus });
  }
  refreshStatus() {
    if (!this.readingStatus) this.readingStatus = (async () => {
      this.lastStatus = await status(this.files.root);
      const serialized = JSON.stringify(this.lastStatus);
      if (serialized !== this.statusJSON) { this.statusJSON = serialized; this.emit('sync', { status: this.lastStatus }); }
    })().finally(() => { this.readingStatus = null; });
    return this.readingStatus;
  }
  scan() {
    this.rescanRequested = true;
    if (!this.scanning) this.scanning = (async () => {
      do {
        this.rescanRequested = false;
        await this.runScan();
      } while (this.rescanRequested && !this.closed);
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async runScan() {
    try {
      const versions = new Map(), stats = new Map();
      for (const file of await this.files.workspaceStats()) {
        try {
          const version = this.stats.get(file.path) === file.fingerprint ? this.versions.get(file.path)
            : etag(await this.files.read({ source: 'workspace' }, file.path));
          versions.set(file.path, version); stats.set(file.path, file.fingerprint);
        } catch (error) { if (error.status !== 404) throw error; }
      }
      const changes = [];
      for (const [name, version] of versions) if (this.versions.get(name) !== version) changes.push({ path: name, version });
      for (const name of this.versions.keys()) if (!versions.has(name)) changes.push({ path: name, version: null });
      this.versions = versions; this.stats = stats;
      if (changes.length) this.emit('files', { source: 'workspace', changes });
      await this.refreshStatus();
    } catch {
      this.emit('resync', { source: 'workspace', reason: '观察工作区失败，请重新读取' });
      throw new Error('观察工作区失败');
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.debounce); clearTimeout(this.statusDebounce);
    clearInterval(this.timer); clearInterval(this.statusTimer); clearInterval(this.heartbeat); this.watcher?.close();
    for (const res of this.clients.keys()) res.end();
    await Promise.all([this.scanning, this.readingStatus]);
  }
}
