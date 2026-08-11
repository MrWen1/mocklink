import { getStore } from '@netlify/blobs';
import crypto from 'crypto';
import path from 'path';

const STORE_NAME = 'mocklink-axure-hosting';
const USERS_KEY = 'system/users.json';
const SESSIONS_KEY = 'system/sessions.json';
const GROUPS_KEY = 'system/groups.json';
const VERIFICATION_CODES_KEY = 'system/verification-codes.json';
const PROTOTYPES_INDEX_KEY = 'prototypes/index.json';

const DEFAULT_QUOTA = {
  projectLimit: 20,
  storageLimitBytes: 100 * 1024 * 1024,
};

const ADMIN_ACCOUNT = {
  email: 'admin',
  password: '666666',
  name: '管理员',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
};

const store = getStore(STORE_NAME, { consistency: 'strong' });

// 模块级缓存：ensureAdminUser 只需在冷启动时执行一次
let _adminEnsured = false;

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sanitizePath(p) {
  if (!p) return '';
  return String(p)
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/^\/+/, '');
}

function normalizePathname(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  const marker = '/.netlify/functions/app';
  if (pathname === marker) pathname = '/';
  if (pathname.startsWith(marker + '/')) pathname = pathname.slice(marker.length);
  return pathname || '/';
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/＠/g, '@')
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    quota: user.quota || DEFAULT_QUOTA,
    createdAt: user.createdAt,
  };
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function metaKey(token) {
  return `prototypes/${token}/meta.json`;
}

function filesIndexKey(token) {
  return `prototypes/${token}/files.json`;
}

function fileBlobKey(token, relPath) {
  return `prototypes/${token}/files/${base64UrlEncode(relPath)}`;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extraHeaders,
    },
  });
}

function htmlResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function redirectResponse(location, status = 302) {
  return new Response('', {
    status,
    headers: { Location: location },
  });
}

function optionsResponse() {
  return new Response('', {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

async function readJSON(key, fallback, consistency = 'strong') {
  try {
    const value = await store.get(key, { type: 'json', consistency });
    return value ?? fallback;
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(key, value) {
  await store.set(key, JSON.stringify(value, null, 2), {
    contentType: 'application/json; charset=utf-8',
  });
}

async function readUsers() {
  const data = await readJSON(USERS_KEY, []);
  return Array.isArray(data) ? data : (data.users || []);
}

async function writeUsers(users) {
  await writeJSON(USERS_KEY, users);
}

async function readSessions() {
  const data = await readJSON(SESSIONS_KEY, []);
  return Array.isArray(data) ? data : (data.sessions || []);
}

async function writeSessions(sessions) {
  await writeJSON(SESSIONS_KEY, sessions);
}

async function readVerificationCodes() {
  const data = await readJSON(VERIFICATION_CODES_KEY, []);
  return Array.isArray(data) ? data : (data.codes || []);
}

async function writeVerificationCodes(codes) {
  await writeJSON(VERIFICATION_CODES_KEY, codes);
}

async function createVerificationCode(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  const now = Date.now();
  const codes = (await readVerificationCodes()).filter(item => new Date(item.expiresAt).getTime() > now);
  codes.push({
    email,
    code,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
  });
  await writeVerificationCodes(codes);
  return code;
}

function verificationEmailContent(code) {
  return {
    subject: 'MockLink验证码',
    text: [
      `您的 MockLink 验证码是：${code}`,
      '',
      '该验证码 10 分钟内有效，请勿转发给他人。',
      '如果不是您本人操作，请忽略本邮件。',
    ].join('\n'),
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;line-height:1.7;color:#222;">
        <h2 style="margin:0 0 16px;">MockLink验证码</h2>
        <p>您的验证码是：</p>
        <div style="display:inline-block;margin:8px 0 16px;padding:10px 18px;background:#f3f6f4;border-radius:6px;color:#439565;font-size:28px;font-weight:700;letter-spacing:4px;">${code}</div>
        <p>该验证码 10 分钟内有效，请勿转发给他人。</p>
        <p style="color:#888;font-size:13px;">如果不是您本人操作，请忽略本邮件。</p>
      </div>
    `,
  };
}

async function sendVerificationEmail(email, code) {
  const content = verificationEmailContent(code);
  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM || process.env.EMAIL_FROM || 'MockLink <noreply@mocklink.local>';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch (e) {}
      throw new Error(`邮件发送失败：${detail || response.status}`);
    }
    return { sent: true, provider: 'resend', subject: content.subject };
  }

  console.log(`[MockLink验证码] ${email}: ${code}`);
  return { sent: false, provider: 'dev', subject: content.subject };
}

async function verifyEmailCode(email, code) {
  const now = Date.now();
  const codes = await readVerificationCodes();
  const idx = codes.findIndex(item =>
    item.email === email &&
    item.code === String(code || '').trim() &&
    new Date(item.expiresAt).getTime() > now
  );
  if (idx < 0) return false;
  codes.splice(idx, 1);
  await writeVerificationCodes(codes.filter(item => new Date(item.expiresAt).getTime() > now));
  return true;
}

async function readGroups() {
  const data = await readJSON(GROUPS_KEY, [], 'eventual');
  return Array.isArray(data) ? data : (data.groups || []);
}

async function writeGroups(groups) {
  await writeJSON(GROUPS_KEY, groups);
}

async function readPrototypeIndex() {
  const data = await readJSON(PROTOTYPES_INDEX_KEY, [], 'eventual');
  return Array.isArray(data) ? data : (data.tokens || []);
}

async function writePrototypeIndex(tokens) {
  await writeJSON(PROTOTYPES_INDEX_KEY, [...new Set(tokens)]);
}

async function addPrototypeToken(token) {
  const tokens = await readPrototypeIndex();
  if (!tokens.includes(token)) {
    tokens.push(token);
    await writePrototypeIndex(tokens);
  }
}

async function removePrototypeToken(token) {
  const tokens = await readPrototypeIndex();
  await writePrototypeIndex(tokens.filter(item => item !== token));
}

async function readMeta(token) {
  return await readJSON(metaKey(token), null, 'eventual');
}

async function writeMeta(token, meta, addToIndex = false) {
  await writeJSON(metaKey(token), meta);
  if (addToIndex) await addPrototypeToken(token);
}

async function readFileIndex(token) {
  const data = await readJSON(filesIndexKey(token), [], 'eventual');
  return Array.isArray(data) ? data : (data.files || []);
}

async function writeFileIndex(token, files) {
  await writeJSON(filesIndexKey(token), files);
}

async function putPrototypeFile(token, relPath, buffer) {
  const key = fileBlobKey(token, relPath);
  await store.set(key, buffer, {
    contentType: getMime(relPath),
  });
  const files = await readFileIndex(token);
  const existing = files.find(item => item.path === relPath);
  const item = {
    path: relPath,
    key,
    size: buffer.byteLength,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    contentType: getMime(relPath),
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, item);
  else files.push(item);
  await writeFileIndex(token, files);
}

async function putPrototypeFilesBatch(token, items) {
  const now = new Date().toISOString();
  const files = await readFileIndex(token);
  const byPath = new Map(files.map(file => [file.path, file]));
  const normalized = items.map(item => {
    const relPath = sanitizePath(item.path);
    const buffer = Buffer.from(item.content || '', 'base64');
    return { relPath, buffer };
  }).filter(item => item.relPath && item.buffer.byteLength >= 0);

  await Promise.all(normalized.map(async ({ relPath, buffer }) => {
    const key = fileBlobKey(token, relPath);
    await store.set(key, buffer, {
      contentType: getMime(relPath),
    });
    byPath.set(relPath, {
      path: relPath,
      key,
      size: buffer.byteLength,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      contentType: getMime(relPath),
      updatedAt: now,
    });
  }));

  await writeFileIndex(token, [...byPath.values()]);
  return normalized.map(item => item.relPath);
}

async function getPrototypeFile(token, relPath) {
  const files = await readFileIndex(token);
  const item = files.find(file => file.path === relPath);
  if (!item) return null;
  const data = await store.get(item.key, { type: 'arrayBuffer', consistency: 'eventual' });
  if (!data) return null;
  return { item, data };
}

async function deletePrototypeFiles(token) {
  const files = await readFileIndex(token);
  await Promise.all(files.map(file => store.delete(file.key).catch(() => {})));
  await writeFileIndex(token, []);
}

async function deletePrototype(token) {
  const files = await readFileIndex(token);
  await Promise.all([
    ...files.map(file => store.delete(file.key).catch(() => {})),
    store.delete(metaKey(token)).catch(() => {}),
    store.delete(filesIndexKey(token)).catch(() => {}),
  ]);
  await removePrototypeToken(token);
}

async function listPrototypeMetas() {
  const tokens = await readPrototypeIndex();
  const results = await Promise.all(tokens.map(async (token) => {
    const meta = await readMeta(token);
    if (!meta) return null;
    const files = await readFileIndex(token);
    const sizeBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return { token, meta, files, sizeBytes };
  }));
  return results.filter(Boolean);
}

async function getUserUsage(userId, user) {
  const items = await listPrototypeMetas();
  const isAdmin = user && user.role === 'admin';
  const owned = items.filter(item =>
    item.meta.ownerId === userId || (isAdmin && !item.meta.ownerId)
  );
  return {
    projectCount: owned.length,
    storageBytes: owned.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

async function assertUserQuota(user, deltaBytes = 0, deltaProjects = 0) {
  if (!user) return { ok: true };
  const quota = user.quota || DEFAULT_QUOTA;
  const usage = await getUserUsage(user.id, user);
  if (quota.projectLimit >= 0 && usage.projectCount + deltaProjects > quota.projectLimit) {
    return { ok: false, error: `项目数量已达配额上限（${quota.projectLimit} 个）` };
  }
  if (quota.storageLimitBytes >= 0 && usage.storageBytes + deltaBytes > quota.storageLimitBytes) {
    return { ok: false, error: `空间已达配额上限（${formatSize(quota.storageLimitBytes)}）` };
  }
  return { ok: true, usage, quota };
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const cookies = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

async function parseJSONBody(request, fallback = {}) {
  const text = await request.text();
  if (!text) return fallback;
  return JSON.parse(text);
}

async function getAuthUser(request) {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const cookieToken = parseCookies(request).wc_auth_token;
  const tokens = [match ? match[1] : null, cookieToken].filter(Boolean);
  if (!tokens.length) return null;
  const [sessions, users] = await Promise.all([readSessions(), readUsers()]);
  for (const token of tokens) {
    const session = sessions.find(s => s.token === token);
    if (!session) continue;
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) continue;
    const user = users.find(u => u.id === session.userId);
    if (user) return user;
  }
  return null;
}

async function requireAuth(request) {
  const user = await getAuthUser(request);
  if (!user) return { response: jsonResponse({ error: '请先登录' }, 401) };
  return { user };
}

async function requireAdmin(request) {
  const { user, response } = await requireAuth(request);
  if (response) return { response };
  if ((user.role || 'user') !== 'admin') return { response: jsonResponse({ error: '需要管理员权限' }, 403) };
  return { user };
}

async function ensureAdminUser() {
  const users = await readUsers();
  const existingIdx = users.findIndex(u => u.id === 'uadmin' || u.email === ADMIN_ACCOUNT.email || u.role === 'admin');
  let changed = false;
  if (existingIdx >= 0) {
    const existing = users[existingIdx];
    const fallbackPassword = existing.passwordHash ? {} : hashPassword(ADMIN_ACCOUNT.password, existing.passwordSalt);
    const next = {
      ...existing,
      id: existing.id || 'uadmin',
      email: existing.email || ADMIN_ACCOUNT.email,
      name: existing.name || ADMIN_ACCOUNT.name,
      role: 'admin',
      passwordSalt: existing.passwordSalt || fallbackPassword.salt,
      passwordHash: existing.passwordHash || fallbackPassword.hash,
      quota: existing.quota || { projectLimit: -1, storageLimitBytes: -1 },
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    changed = JSON.stringify(existing) !== JSON.stringify(next);
    if (changed) users[existingIdx] = next;
  } else {
    const { salt, hash } = hashPassword(ADMIN_ACCOUNT.password);
    users.unshift({
      id: 'uadmin',
      email: ADMIN_ACCOUNT.email,
      name: ADMIN_ACCOUNT.name,
      role: 'admin',
      passwordSalt: salt,
      passwordHash: hash,
      quota: { projectLimit: -1, storageLimitBytes: -1 },
      createdAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) await writeUsers(users);
}

function findEntryPath(files, requestedEntry = '') {
  const paths = files.map(file => file.path);
  if (paths.includes('index.html')) return 'index.html';
  if (paths.includes('start.html')) return 'start.html';
  if (requestedEntry && paths.includes(requestedEntry)) return requestedEntry;
  return paths.filter(item => /\.html?$/i.test(item)).sort()[0] || '';
}

function resolveRelativeAsset(fromPath, ref) {
  if (!ref) return '';
  const value = String(ref).trim().split('#')[0].split('?')[0];
  if (!value || value.startsWith('#')) return '';
  if (/^(?:https?:)?\/\//i.test(value)) return '';
  if (/^(?:data|blob|mailto|javascript|about):/i.test(value)) return '';
  if (value.startsWith('/')) return sanitizePath(value);
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  return sanitizePath(path.posix.normalize(dir + value));
}

function isIgnorableMissingPrototypeResource(relPath) {
  const p = sanitizePath(relPath).toLowerCase();
  return (
    p.startsWith('googlefonts/') ||
    p === 'resources/css/pie.htc' ||
    p.startsWith('resources/css/previewfonts/') ||
    p.startsWith('resources/css/images/ui-') ||
    p === 'resources/axurerp_pagescript.js' ||
    p.startsWith('plugins/handoff/') ||
    p.startsWith('plugins/sitemap/styles/images/')
  );
}

async function validatePrototypeReferences(token, files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const existing = new Set(byPath.keys());
  const missing = new Set();
  const textFiles = files
    .map(file => file.path)
    .filter(filePath => /\.(html?|css)$/i.test(filePath));

  const textFileItems = textFiles.map(fp => byPath.get(fp)).filter(Boolean);
  const fileDatas = await Promise.all(textFileItems.map(async (item) => {
    const data = await store.get(item.key, { type: 'arrayBuffer', consistency: 'eventual' });
    return { item, text: data ? Buffer.from(data).toString('utf8') : '' };
  }));

  for (const { item, text } of fileDatas) {
    if (!text) continue;
    const refs = [];

    if (/\.html?$/i.test(item.path)) {
      const attrMatches = text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi);
      for (const match of attrMatches) refs.push(match[1]);
    }

    const cssMatches = text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
    for (const match of cssMatches) refs.push(match[1]);

    for (const ref of refs) {
      const resolved = resolveRelativeAsset(item.path, ref);
      if (resolved && !existing.has(resolved) && !isIgnorableMissingPrototypeResource(resolved)) {
        missing.add(resolved);
      }
    }
  }

  return [...missing].sort();
}

async function handleAPI(request, pathname) {
  if (request.method === 'OPTIONS') return optionsResponse();

  if (['/api/auth/send-code', '/api/auth/send-email-code', '/api/auth/email-code'].includes(pathname) && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return jsonResponse({ error: '请输入有效邮箱' }, 400);
      const users = await readUsers();
      if (users.some(u => u.email === email)) return jsonResponse({ error: '该邮箱已注册' }, 409);
      const code = await createVerificationCode(email);
      const mail = await sendVerificationEmail(email, code);
      const payload = {
        ok: true,
        message: mail.sent ? 'MockLink验证码已发送，请查收邮箱' : '测试环境验证码已生成，有效期 10 分钟',
        mailSent: mail.sent,
        subject: mail.subject,
      };
      if (!mail.sent) payload.devCode = code;
      return jsonResponse({
        ...payload,
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/auth/send-reset-code' && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return jsonResponse({ error: '请输入有效邮箱' }, 400);
      const users = await readUsers();
      if (!users.some(u => u.email === email)) return jsonResponse({ error: '该邮箱尚未注册' }, 404);
      const code = await createVerificationCode(email);
      const mail = await sendVerificationEmail(email, code);
      const payload = {
        ok: true,
        message: mail.sent ? 'MockLink重置密码验证码已发送，请查收邮箱' : '测试环境验证码已生成，有效期 10 分钟',
        mailSent: mail.sent,
        subject: mail.subject,
      };
      if (!mail.sent) payload.devCode = code;
      return jsonResponse({
        ...payload,
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/auth/register' && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      const verificationCode = String(body.verificationCode || '').trim();
      const name = String(body.name || email.split('@')[0] || '新用户').trim();
      if (!isValidEmail(email)) return jsonResponse({ error: '请输入有效邮箱' }, 400);
      if (!verificationCode) return jsonResponse({ error: '请输入邮箱验证码' }, 400);
      if (password.length < 6) return jsonResponse({ error: '密码至少 6 位' }, 400);
      if (password !== confirmPassword) return jsonResponse({ error: '两次输入的密码不一致' }, 400);
      const codeOk = await verifyEmailCode(email, verificationCode);
      if (!codeOk) return jsonResponse({ error: '邮箱验证码错误或已过期' }, 400);
      const users = await readUsers();
      if (users.some(u => u.email === email)) return jsonResponse({ error: '该邮箱已注册' }, 409);
      const { salt, hash } = hashPassword(password);
      const user = {
        id: 'u' + crypto.randomBytes(8).toString('hex'),
        email,
        name,
        role: users.length === 0 ? 'admin' : 'user',
        passwordSalt: salt,
        passwordHash: hash,
        quota: { ...DEFAULT_QUOTA },
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeUsers(users);
      const token = crypto.randomBytes(24).toString('hex');
      const sessions = await readSessions();
      sessions.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
      await writeSessions(sessions);
      return jsonResponse({ token, user: publicUser(user) }, 200, {
        'Set-Cookie': `wc_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/auth/reset-password' && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      const verificationCode = String(body.verificationCode || '').trim();
      if (!isValidEmail(email)) return jsonResponse({ error: '请输入有效邮箱' }, 400);
      if (!verificationCode) return jsonResponse({ error: '请输入邮箱验证码' }, 400);
      if (password.length < 6) return jsonResponse({ error: '密码至少 6 位' }, 400);
      if (password !== confirmPassword) return jsonResponse({ error: '两次输入的密码不一致' }, 400);
      const users = await readUsers();
      const userIndex = users.findIndex(u => u.email === email);
      if (userIndex < 0) return jsonResponse({ error: '该邮箱尚未注册' }, 404);
      const codeOk = await verifyEmailCode(email, verificationCode);
      if (!codeOk) return jsonResponse({ error: '邮箱验证码错误或已过期' }, 400);
      const { salt, hash } = hashPassword(password);
      users[userIndex] = {
        ...users[userIndex],
        passwordSalt: salt,
        passwordHash: hash,
        passwordUpdatedAt: new Date().toISOString(),
      };
      await writeUsers(users);
      const sessions = await readSessions();
      await writeSessions(sessions.filter(s => s.userId !== users[userIndex].id));
      return jsonResponse({ ok: true, message: '密码已重置，请使用新密码登录' });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const users = await readUsers();
      const user = users.find(u => u.email === email);
      if (!user) return jsonResponse({ error: '邮箱或密码错误' }, 401);
      const { hash } = hashPassword(password, user.passwordSalt);
      if (hash !== user.passwordHash) return jsonResponse({ error: '邮箱或密码错误' }, 401);
      const token = crypto.randomBytes(24).toString('hex');
      const sessions = await readSessions();
      sessions.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
      await writeSessions(sessions);
      return jsonResponse({ token, user: publicUser(user) }, 200, {
        'Set-Cookie': `wc_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const auth = request.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const cookieToken = parseCookies(request).wc_auth_token;
    const token = match ? match[1] : cookieToken;
    if (token) {
      const sessions = await readSessions();
      await writeSessions(sessions.filter(s => s.token !== token));
    }
    return jsonResponse({ ok: true }, 200, {
      'Set-Cookie': 'wc_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await getAuthUser(request);
    if (!user) return jsonResponse({ user: null });
    const usage = await getUserUsage(user.id, user);
    return jsonResponse({ user: publicUser(user), usage });
  }

  if (pathname === '/api/admin/users' && request.method === 'GET') {
    const { response } = await requireAdmin(request);
    if (response) return response;
    const users = await readUsers();
    const items = await listPrototypeMetas();
    const data = users.map(user => {
      const isAdmin = (user.role || 'user') === 'admin';
      const owned = items.filter(item =>
        item.meta.ownerId === user.id || (isAdmin && !item.meta.ownerId)
      );
      return {
        ...publicUser(user),
        usage: {
          projectCount: owned.length,
          storageBytes: owned.reduce((sum, item) => sum + item.sizeBytes, 0),
        },
      };
    });
    return jsonResponse({ users: data });
  }

  if (pathname === '/api/admin/users' && request.method === 'POST') {
    const { response } = await requireAdmin(request);
    if (response) return response;
    try {
      const body = await parseJSONBody(request);
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!name) return jsonResponse({ error: '姓名不能为空' }, 400);
      if (!email) return jsonResponse({ error: '账号不能为空' }, 400);
      if (password.length < 6) return jsonResponse({ error: '密码至少 6 位' }, 400);
      const users = await readUsers();
      if (users.some(u => u.email === email)) return jsonResponse({ error: '该账号已存在' }, 409);
      const projectLimit = Number(body.projectLimit);
      const storageLimitMB = Number(body.storageLimitMB);
      const { salt, hash } = hashPassword(password);
      const user = {
        id: 'u' + crypto.randomBytes(8).toString('hex'),
        email,
        name,
        role: 'user',
        passwordSalt: salt,
        passwordHash: hash,
        quota: {
          projectLimit: Number.isFinite(projectLimit) ? Math.max(-1, Math.floor(projectLimit)) : DEFAULT_QUOTA.projectLimit,
          storageLimitBytes: Number.isFinite(storageLimitMB) ? Math.max(-1, Math.floor(storageLimitMB * 1024 * 1024)) : DEFAULT_QUOTA.storageLimitBytes,
        },
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeUsers(users);
      return jsonResponse({ user: publicUser(user), usage: await getUserUsage(user.id, user) });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && request.method === 'PUT') {
    const { response } = await requireAdmin(request);
    if (response) return response;
    try {
      const body = await parseJSONBody(request);
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === adminUserMatch[1]);
      if (idx < 0) return jsonResponse({ error: '用户不存在' }, 404);
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!name) return jsonResponse({ error: '姓名不能为空' }, 400);
      if (!email) return jsonResponse({ error: '账号不能为空' }, 400);
      if (users.some((u, i) => i !== idx && u.email === email)) return jsonResponse({ error: '该账号已存在' }, 409);
      if (password && password.length < 6) return jsonResponse({ error: '密码至少 6 位' }, 400);
      users[idx].name = name;
      users[idx].email = email;
      if (password) {
        const { salt, hash } = hashPassword(password);
        users[idx].passwordSalt = salt;
        users[idx].passwordHash = hash;
      }
      const projectLimit = Number(body.projectLimit);
      const storageLimitMB = Number(body.storageLimitMB);
      users[idx].quota = {
        projectLimit: Number.isFinite(projectLimit) ? Math.max(-1, Math.floor(projectLimit)) : (users[idx].quota?.projectLimit ?? DEFAULT_QUOTA.projectLimit),
        storageLimitBytes: Number.isFinite(storageLimitMB) ? Math.max(-1, Math.floor(storageLimitMB * 1024 * 1024)) : (users[idx].quota?.storageLimitBytes ?? DEFAULT_QUOTA.storageLimitBytes),
      };
      await writeUsers(users);
      return jsonResponse({ user: publicUser(users[idx]), usage: await getUserUsage(users[idx].id, users[idx]) });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (adminUserMatch && request.method === 'DELETE') {
    const { user: admin, response } = await requireAdmin(request);
    if (response) return response;
    try {
      const userId = adminUserMatch[1];
      if (userId === admin.id) return jsonResponse({ error: '不能删除当前登录账号' }, 400);
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx < 0) return jsonResponse({ error: '用户不存在' }, 404);
      if ((users[idx].role || 'user') === 'admin') {
        const adminCount = users.filter(u => (u.role || 'user') === 'admin').length;
        if (adminCount <= 1) return jsonResponse({ error: '至少保留一个管理员账号' }, 400);
      }
      const removed = users.splice(idx, 1)[0];
      const sessions = await readSessions();
      await Promise.all([
        writeUsers(users),
        writeSessions(sessions.filter(s => s.userId !== userId)),
      ]);
      const items = await listPrototypeMetas();
      const now = new Date().toISOString();
      await Promise.all(items.filter(item => item.meta.ownerId === userId).map(item => {
        item.meta.ownerId = null;
        item.meta.updatedAt = now;
        return writeMeta(item.token, item.meta);
      }));
      return jsonResponse({ ok: true, user: publicUser(removed) });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const quotaMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/quota$/);
  if (quotaMatch && request.method === 'PUT') {
    const { response } = await requireAdmin(request);
    if (response) return response;
    try {
      const body = await parseJSONBody(request);
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === quotaMatch[1]);
      if (idx < 0) return jsonResponse({ error: '用户不存在' }, 404);
      const projectLimit = Number(body.projectLimit);
      const storageLimitMB = Number(body.storageLimitMB);
      users[idx].quota = {
        projectLimit: Number.isFinite(projectLimit) ? Math.max(-1, Math.floor(projectLimit)) : (users[idx].quota?.projectLimit ?? DEFAULT_QUOTA.projectLimit),
        storageLimitBytes: Number.isFinite(storageLimitMB) ? Math.max(-1, Math.floor(storageLimitMB * 1024 * 1024)) : (users[idx].quota?.storageLimitBytes ?? DEFAULT_QUOTA.storageLimitBytes),
      };
      await writeUsers(users);
      return jsonResponse({ user: publicUser(users[idx]), usage: await getUserUsage(users[idx].id, users[idx]) });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/groups' && request.method === 'GET') {
    return jsonResponse({ groups: await readGroups() });
  }

  if (pathname === '/api/groups' && request.method === 'POST') {
    try {
      const body = await parseJSONBody(request);
      const name = String(body.name || '').trim();
      if (!name) return jsonResponse({ error: '分组名称不能为空' }, 400);
      const groups = await readGroups();
      if (body.parentId) {
        const parent = groups.find(g => g.id === body.parentId);
        if (!parent) return jsonResponse({ error: '父分组不存在' }, 400);
        if (parent.parentId) return jsonResponse({ error: '最多支持二级分组' }, 400);
      }
      const group = {
        id: 'g' + crypto.randomBytes(4).toString('hex'),
        name,
        parentId: body.parentId || null,
        createdAt: new Date().toISOString(),
      };
      groups.push(group);
      await writeGroups(groups);
      return jsonResponse(group);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch && request.method === 'PUT') {
    try {
      const id = groupMatch[1];
      const body = await parseJSONBody(request);
      const groups = await readGroups();
      const idx = groups.findIndex(g => g.id === id);
      if (idx < 0) return jsonResponse({ error: '分组不存在' }, 404);
      if (body.name !== undefined) groups[idx].name = String(body.name).trim() || groups[idx].name;
      if (body.parentId !== undefined) {
        if (body.parentId) {
          if (body.parentId === id) return jsonResponse({ error: '不能将分组设为自身的子分组' }, 400);
          const parent = groups.find(g => g.id === body.parentId);
          if (!parent) return jsonResponse({ error: '父分组不存在' }, 400);
          if (parent.parentId) return jsonResponse({ error: '最多支持二级分组' }, 400);
        }
        groups[idx].parentId = body.parentId || null;
      }
      await writeGroups(groups);
      return jsonResponse(groups[idx]);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (groupMatch && request.method === 'DELETE') {
    try {
      const id = groupMatch[1];
      let groups = await readGroups();
      const toDelete = new Set([id]);
      groups.forEach(g => { if (g.parentId === id) toDelete.add(g.id); });
      groups = groups.filter(g => !toDelete.has(g.id));
      await writeGroups(groups);
      const items = await listPrototypeMetas();
      const now = new Date().toISOString();
      await Promise.all(items.filter(item => item.meta.groupId && toDelete.has(item.meta.groupId)).map(item => {
        item.meta.groupId = null;
        item.meta.updatedAt = now;
        return writeMeta(item.token, item.meta);
      }));
      return jsonResponse({ ok: true, message: '已删除分组' });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/extension/download' && request.method === 'GET') {
    return redirectResponse('/extension.zip');
  }

  if (pathname === '/api/prototypes' && request.method === 'GET') {
    try {
      const currentUser = await getAuthUser(request);
      const [users, items] = await Promise.all([readUsers(), listPrototypeMetas()]);
      const prototypes = [];
      for (const item of items) {
        const meta = item.meta;
        if (currentUser && currentUser.role !== 'admin' && meta.ownerId && meta.ownerId !== currentUser.id) continue;
        const owner = users.find(u => u.id === meta.ownerId);
        const files = item.files || [];
        prototypes.push({
          token: meta.token,
          name: meta.name || '未命名原型',
          status: meta.status || 'unknown',
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt || meta.publishedAt || meta.createdAt,
          publishedAt: meta.publishedAt,
          fileCount: meta.fileCount || files.length,
          size: formatSize(item.sizeBytes),
          sizeBytes: item.sizeBytes,
          hasIndex: meta.hasIndex !== undefined ? meta.hasIndex : files.some(file => file.path === 'index.html'),
          groupId: meta.groupId || null,
          ownerId: meta.ownerId || null,
          ownerName: owner ? (owner.name || owner.email) : '未归属',
        });
      }
      prototypes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return jsonResponse({ prototypes });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (pathname === '/api/prototypes' && request.method === 'POST') {
    try {
      const currentUser = await getAuthUser(request);
      const body = await parseJSONBody(request);
      const projectName = String(body.name || '').trim();
      if (!projectName) return jsonResponse({ error: '项目名称不能为空' }, 400);
      if (currentUser) {
        const quotaCheck = await assertUserQuota(currentUser, 0, 1);
        if (!quotaCheck.ok) return jsonResponse({ error: quotaCheck.error }, 403);
      }
      const token = crypto.randomBytes(6).toString('hex');
      const meta = {
        token,
        name: projectName,
        status: body.empty ? 'empty' : 'uploading',
        createdAt: new Date().toISOString(),
        fileCount: 0,
        entryPath: body.entryPath ? sanitizePath(body.entryPath) : '',
        groupId: body.groupId || null,
        ownerId: currentUser ? currentUser.id : null,
      };
      await writeMeta(token, meta, true);
      if (!body.empty) await writeFileIndex(token, []);
      return jsonResponse({ token, uploadUrl: `/api/prototypes/${token}/files` });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const protoMatch = pathname.match(/^\/api\/prototypes\/([^/]+)$/);
  if (protoMatch && request.method === 'GET') {
    const meta = await readMeta(protoMatch[1]);
    if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
    return jsonResponse(meta);
  }

  if (protoMatch && request.method === 'PUT') {
    try {
      const token = protoMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const body = await parseJSONBody(request);
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = String(body.name || '').trim();
        if (!name) return jsonResponse({ error: '项目名称不能为空' }, 400);
        meta.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'groupId')) {
        meta.groupId = body.groupId || null;
      }
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({ ok: true, prototype: meta });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (protoMatch && request.method === 'DELETE') {
    try {
      const token = protoMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      await deletePrototype(token);
      return jsonResponse({ ok: true, message: '已删除' });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const clearMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/clear$/);
  if (clearMatch && request.method === 'POST') {
    try {
      const token = clearMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      await deletePrototypeFiles(token);
      meta.status = 'cleared';
      meta.fileCount = 0;
      meta.hasIndex = false;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({ ok: true, message: '已清空 HTML' });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const filesListMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files$/);
  if (filesListMatch && request.method === 'GET') {
    try {
      const token = filesListMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const files = await readFileIndex(token);
      return jsonResponse({
        files: files.map(f => ({ path: f.path, size: f.size, hash: f.hash || null, updatedAt: f.updatedAt })),
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const fileMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files$/);
  if (fileMatch && request.method === 'POST') {
    try {
      const token = fileMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const body = await parseJSONBody(request);
      const relPath = sanitizePath(body.path);
      if (!relPath || !body.content) return jsonResponse({ error: '缺少文件路径或内容' }, 400);
      const buffer = Buffer.from(body.content, 'base64');
      if (meta.ownerId) {
        const users = await readUsers();
        const owner = users.find(u => u.id === meta.ownerId);
        if (owner) {
          const quotaCheck = await assertUserQuota(owner, buffer.byteLength, 0);
          if (!quotaCheck.ok) return jsonResponse({ error: quotaCheck.error }, 403);
        }
      }
      await putPrototypeFile(token, relPath, buffer);
      const files = await readFileIndex(token);
      meta.fileCount = files.length;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({ ok: true, path: relPath });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const batchFileMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files\/batch$/);
  if (batchFileMatch && request.method === 'POST') {
    try {
      const token = batchFileMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const body = await parseJSONBody(request);
      const uploadFiles = Array.isArray(body.files) ? body.files : [];
      if (!uploadFiles.length) return jsonResponse({ error: '缺少文件列表' }, 400);
      if (uploadFiles.length > 80) return jsonResponse({ error: '单批文件数量过多' }, 400);

      const normalized = uploadFiles.map(item => ({
        path: sanitizePath(item.path),
        content: item.content || '',
      })).filter(item => item.path && item.content);
      if (!normalized.length) return jsonResponse({ error: '缺少有效文件' }, 400);

      const totalBytes = normalized.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'base64'), 0);
      if (meta.ownerId) {
        const users = await readUsers();
        const owner = users.find(u => u.id === meta.ownerId);
        if (owner) {
          const quotaCheck = await assertUserQuota(owner, totalBytes, 0);
          if (!quotaCheck.ok) return jsonResponse({ error: quotaCheck.error }, 403);
        }
      }

      const paths = await putPrototypeFilesBatch(token, normalized);
      const files = await readFileIndex(token);
      meta.fileCount = files.length;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({ ok: true, count: paths.length, paths });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const deleteFilesMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files\/delete$/);
  if (deleteFilesMatch && request.method === 'POST') {
    try {
      const token = deleteFilesMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const body = await parseJSONBody(request);
      const paths = Array.isArray(body.paths) ? body.paths.map(sanitizePath).filter(Boolean) : [];
      if (!paths.length) return jsonResponse({ error: '缺少要删除的文件路径' }, 400);
      const files = await readFileIndex(token);
      const toDelete = new Set(paths);
      const remaining = files.filter(f => !toDelete.has(f.path));
      const deleted = files.filter(f => toDelete.has(f.path));
      await Promise.all(deleted.map(f => store.delete(f.key).catch(() => {})));
      await writeFileIndex(token, remaining);
      meta.fileCount = remaining.length;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({ ok: true, deleted: deleted.length, remaining: remaining.length });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const updateMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/update$/);
  if (updateMatch && request.method === 'POST') {
    try {
      const token = updateMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      const currentUser = await getAuthUser(request);
      if (!meta.ownerId && currentUser) meta.ownerId = currentUser.id;
      let body = {};
      try { body = await parseJSONBody(request); } catch (e) {}
      await deletePrototypeFiles(token);
      meta.status = 'updating';
      meta.fileCount = 0;
      meta.hasIndex = false;
      if (body.name) meta.name = String(body.name).trim();
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      return jsonResponse({
        token,
        uploadUrl: `/api/prototypes/${token}/files`,
        shareUrl: `/s/${token}`,
        message: '已清空旧文件，可重新上传',
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  const pubMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/publish$/);
  if (pubMatch && request.method === 'POST') {
    try {
      const token = pubMatch[1];
      const meta = await readMeta(token);
      if (!meta) return jsonResponse({ error: '原型不存在' }, 404);
      let body = {};
      try { body = await parseJSONBody(request); } catch (e) {}
      const files = await readFileIndex(token);
      const missingFiles = await validatePrototypeReferences(token, files);
      if (missingFiles.length > 0) {
        const sample = missingFiles.slice(0, 5).join('；');
        return jsonResponse({
          error: `有 ${missingFiles.length} 个关键资源文件缺失，请重新上传完整 Axure 发布目录。缺失示例：${sample}`,
          missingFiles: missingFiles.slice(0, 50),
        }, 400);
      }
      const requestedEntry = sanitizePath(body.entryPath || meta.entryPath || '');
      const entryPath = findEntryPath(files, requestedEntry);
      const hasIndex = !!entryPath;
      meta.status = 'ready';
      meta.hasIndex = hasIndex;
      meta.entryPath = entryPath;
      meta.fileCount = files.length;
      meta.publishedAt = new Date().toISOString();
      meta.updatedAt = meta.publishedAt;
      await writeMeta(token, meta);
      return jsonResponse({
        token,
        shareUrl: `/s/${token}`,
        viewUrl: `/v/${token}/`,
        hasIndex,
        entryPath,
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: 'API 不存在' }, 404);
}

async function handleShare(pathname) {
  const sMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (sMatch) {
    const meta = await readMeta(sMatch[1]);
    if (!meta) return htmlResponse('<h1>原型不存在或已删除</h1>', 404);
    return redirectResponse(`/v/${sMatch[1]}/`);
  }

  const vMatch = pathname.match(/^\/v\/([^/]+)(.*)$/);
  if (!vMatch) return null;

  const token = vMatch[1];
  const meta = await readMeta(token);
  if (!meta) return htmlResponse('<h1>原型不存在</h1>', 404);

  let relPath = vMatch[2] || '';
  relPath = relPath.replace(/^\/+/, '');
  const isRootRequest = relPath === '' || relPath.endsWith('/');
  if (isRootRequest) relPath += 'index.html';
  try { relPath = decodeURIComponent(relPath); } catch (e) {}
  relPath = sanitizePath(relPath) || 'index.html';

  let file = await getPrototypeFile(token, relPath);
  if (!file && relPath === 'index.html') {
    file = await getPrototypeFile(token, 'start.html');
    if (!file && meta.entryPath) file = await getPrototypeFile(token, sanitizePath(meta.entryPath));
    if (!file) {
      const files = await readFileIndex(token);
      const firstHtml = files.map(item => item.path).filter(item => /\.html?$/i.test(item)).sort()[0];
      if (firstHtml) file = await getPrototypeFile(token, firstHtml);
    }
  }

  if (!file) return htmlResponse('<h1>文件不存在</h1>', 404);

  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': file.item.contentType || getMime(file.item.path),
      'Content-Length': String(file.item.size || file.data.byteLength || 0),
      'Cache-Control': 'no-cache',
    },
  });
}

export default async (request) => {
  const pathname = normalizePathname(request);

  try {
    if (!_adminEnsured) {
      await ensureAdminUser();
      _adminEnsured = true;
    }

    if (pathname.startsWith('/api/')) {
      return await handleAPI(request, pathname);
    }

    if (pathname.startsWith('/s/') || pathname.startsWith('/v/')) {
      const response = await handleShare(pathname);
      if (response) return response;
    }

    return htmlResponse('<h1>404 Not Found</h1>', 404);
  } catch (e) {
    console.error('Netlify Function error:', e);
    return jsonResponse({ error: e.message || '服务器错误' }, 500);
  }
};
