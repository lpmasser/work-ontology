import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateTree } from '../core/validation.mjs';

const port = process.env.PORT;
if (!port) {
  console.error('环境变量 PORT 未设置');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/validate') {
    let tempDir;
    let status = 200;
    let body = '';
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), 'infohub-validate-'));

      try { await pipeline(req, x({ cwd: tempDir, strict: true })); }
      catch (err) { throw new Error(`tar 解包失败: ${err.message}`); }

      const changedPath = path.join(tempDir, '.infohub-changed');
      let changedContent;
      try {
        changedContent = await readFile(changedPath, 'utf8');
      } catch (err) {
        throw new Error(`缺少 .infohub-changed: ${err.message}`);
      }

      const changedPaths = changedContent
        .split('\n')
        .filter(Boolean);

      const issues = await validateTree(tempDir, changedPaths);

      if (issues.length === 0) {
        status = 200;
        body = '无问题';
      } else {
        status = 422;
        const lines = issues.map((i) => `${i.path}：${i.message}`);
        lines.push(`共 ${issues.length} 个问题`);
        body = lines.join('\n');
      }
    } catch (err) {
      status = 400;
      body = err.message;
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(Number(port), () => {
  console.log(`infohub-validator listening on ${port}`);
});
