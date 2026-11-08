import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const digest = token => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export const validHash = hash => /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);

export class Sessions {
  constructor(users, { ttlSeconds = 86400, secure = true } = {}) {
    this.users = users; this.ttl = ttlSeconds * 1000; this.secure = secure;
    this.sessions = new Map(); this.attempts = new Map();
  }
  cookie(token, maxAge = this.ttl / 1000) {
    return `infohub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
  async login(username, password, address) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until < now) this.attempts.delete(key);
    const key = `${address}:${username}`, attempt = this.attempts.get(key);
    if (attempt?.count >= 10) return { limited: true };
    if (this.attempts.size >= 1000) return { limited: true };
    const user = this.users.find(u => u.username === username);
    const [, salt, hash] = (user?.passwordHash || `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    const actual = await scrypt(password, salt, 64);
    if (!user || !timingSafeEqual(actual, Buffer.from(hash, 'hex'))) {
      this.attempts.set(key, { count: (attempt?.count || 0) + 1, until: attempt?.until || now + 60000 });
      return {};
    }
    this.attempts.delete(key);
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('hex'), expires = now + this.ttl;
    this.sessions.set(digest(token), { user, expires });
    return { user, expires, cookie: this.cookie(token) };
  }
  token(req) { return /(?:^|;\s*)infohub_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
  get(req) {
    const token = this.token(req), key = token && digest(token), session = key && this.sessions.get(key);
    if (!session) return null;
    if (session.expires <= Date.now()) { this.sessions.delete(key); return null; }
    return session;
  }
  logout(req) { const token = this.token(req); if (token) this.sessions.delete(digest(token)); return this.cookie('', 0); }
}
