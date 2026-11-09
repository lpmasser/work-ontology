export function normalizeWebUrl(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('webUrl 必须是不含凭据、查询和锚点的 HTTP(S) 网页地址');
  return url.href.replace(/\/+$/, '');
}
export const objectUrl = (webUrl, id) => webUrl ? `${normalizeWebUrl(webUrl)}/o/${encodeURIComponent(id)}` : undefined;
export const withObjectUrl = (object, webUrl) => webUrl ? { ...object, url: objectUrl(webUrl, object.id) } : object;
export const objectLocation = object => `${object.path}${object.url ? ` — ${object.url}` : ''}`;
export function webUsers(config = {}) {
  const users = config.webUser === undefined ? [] : Array.isArray(config.webUser) ? config.webUser : [config.webUser];
  if (users.some(user => typeof user !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(user))) throw new Error('webUser 必须是网页用户名或用户名数组');
  return users;
}
