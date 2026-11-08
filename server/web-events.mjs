import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { status } from '../sync/command.mjs';
import { etag } from './web-files.mjs';

export class WorkspaceEvents {
  constructor(files, sessions, intervalMs = 1000) {
    this.files = files; this.sessions = sessions; this.intervalMs = intervalMs;
    this.clients = new Map(); this.versions = new Map(); this.serial = 0; this.boot = randomUUID();
  }
  async start() {
    await this.scan();
    try {
      this.watcher = watch(this.files.root, { recursive: true }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan().catch(() => {}), 75);
      });
      this.watcher.on('error', () => { this.watcher.close(); });
    } catch { /* The periodic scan also covers systems without recursive watch. */ }
    this.timer = setInterval(() => this.scan().catch(() => {}), this.intervalMs);
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
  scan() {
    if (!this.scanning) this.scanning = this.runScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async runScan() {
    try {
      const versions = new Map();
      for (const file of await this.files.tree({ source: 'workspace' })) {
        try { versions.set(file.path, etag(await this.files.read({ source: 'workspace' }, file.path))); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      const changes = [];
      for (const [name, version] of versions) if (this.versions.get(name) !== version) changes.push({ path: name, version });
      for (const name of this.versions.keys()) if (!versions.has(name)) changes.push({ path: name, version: null });
      this.versions = versions;
      if (changes.length) this.emit('files', { source: 'workspace', changes });
      this.lastStatus = await status(this.files.root);
      const serialized = JSON.stringify(this.lastStatus);
      if (serialized !== this.statusJSON) { this.statusJSON = serialized; this.emit('sync', { status: this.lastStatus }); }
    } catch {
      this.emit('resync', { source: 'workspace', reason: '观察工作区失败，请重新读取' });
      throw new Error('观察工作区失败');
    }
  }
  async close() {
    clearTimeout(this.debounce); clearInterval(this.timer); clearInterval(this.heartbeat); this.watcher?.close();
    for (const res of this.clients.keys()) res.end();
    await this.scanning;
  }
}
