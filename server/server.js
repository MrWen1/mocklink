// Axure 原型托管服务 - MockLink
// 零依赖，纯 Node.js 内置模块
// 无登录，匿名上传，token 即原型身份，/s/:token 分享，/v/:token/ 在线查看
import http from 'http';
import fs from 'fs/promises';
import { existsSync, createReadStream, statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const PORT = process.env.PORT || 3000;
const STORAGE_DIR = path.join(import.meta.dirname, 'storage');
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const EXTENSION_DIR = path.join(import.meta.dirname, '..', 'extension');
const GROUPS_FILE = path.join(STORAGE_DIR, 'groups.json');
const USERS_FILE = path.join(STORAGE_DIR, 'users.json');
const SESSIONS_FILE = path.join(STORAGE_DIR, 'sessions.json');
const VERIFICATION_CODES_FILE = path.join(STORAGE_DIR, 'verification-codes.json');
const DEFAULT_QUOTA = {
  projectLimit: 20,
  storageLimitBytes: 100 * 1024 * 1024,
};
const ADMIN_ACCOUNT = {
  email: 'admin',
  password: '666666',
  name: '管理员',
};

await fs.mkdir(STORAGE_DIR, { recursive: true });

// ---------- MIME 类型 ----------
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
  '.woff': 'font/woff',
};

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------- 工具函数 ----------
function sanitizePath(p) {
  if (!p) return '';
  return String(p)
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/^\/+/, '');
}

function protoDir(token) {
  return path.resolve(path.join(STORAGE_DIR, token));
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

async function listPrototypeFiles(dir, current = '') {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(path.join(dir, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'meta.json') continue;
    const rel = current ? `${current}/${entry.name}` : entry.name;
    const full = path.join(dir, rel);
    if (entry.isDirectory()) {
      files.push(...await listPrototypeFiles(dir, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function validatePrototypeReferences(dir) {
  const files = await listPrototypeFiles(dir);
  const existing = new Set(files);
  const missing = new Set();
  const textFiles = files.filter(filePath => /\.(html?|css)$/i.test(filePath));

  for (const filePath of textFiles) {
    const full = path.join(dir, filePath);
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    const refs = [];

    if (/\.html?$/i.test(filePath)) {
      const attrMatches = text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi);
      for (const match of attrMatches) refs.push(match[1]);
    }

    const cssMatches = text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
    for (const match of cssMatches) refs.push(match[1]);

    for (const ref of refs) {
      const resolved = resolveRelativeAsset(filePath, ref);
      if (resolved && !existing.has(resolved)) missing.add(resolved);
    }
  }

  return [...missing].sort();
}

async function readMeta(token) {
  const metaPath = path.join(STORAGE_DIR, token, 'meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(await fs.readFile(metaPath, 'utf8'));
}

async function writeMeta(token, meta) {
  await fs.writeFile(
    path.join(STORAGE_DIR, token, 'meta.json'),
    JSON.stringify(meta, null, 2)
  );
}

// ---------- 读取请求体 ----------
function readBody(req, maxBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, code, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  });
  res.end(body);
}

// ---------- 用户、会话与配额 ----------
async function readUsers() {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const data = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    return Array.isArray(data) ? data : (data.users || []);
  } catch (e) { return []; }
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

async function readSessions() {
  if (!existsSync(SESSIONS_FILE)) return [];
  try {
    const data = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
    return Array.isArray(data) ? data : (data.sessions || []);
  } catch (e) { return []; }
}

async function writeSessions(sessions) {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

async function readVerificationCodes() {
  if (!existsSync(VERIFICATION_CODES_FILE)) return [];
  try {
    const data = JSON.parse(await fs.readFile(VERIFICATION_CODES_FILE, 'utf8'));
    return Array.isArray(data) ? data : (data.codes || []);
  } catch (e) { return []; }
}

async function writeVerificationCodes(codes) {
  await fs.writeFile(VERIFICATION_CODES_FILE, JSON.stringify(codes, null, 2));
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

function parseCookies(req) {
  const header = req.headers.cookie || '';
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

async function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const cookieToken = parseCookies(req).wc_auth_token;
  const tokens = [match ? match[1] : null, cookieToken].filter(Boolean);
  if (!tokens.length) return null;
  const sessions = await readSessions();
  const users = await readUsers();
  for (const token of tokens) {
    const session = sessions.find(s => s.token === token);
    if (!session) continue;
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) continue;
    const user = users.find(u => u.id === session.userId);
    if (user) return user;
  }
  return null;
}

async function requireAuth(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    sendJSON(res, 401, { error: '请先登录' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if ((user.role || 'user') !== 'admin') {
    sendJSON(res, 403, { error: '需要管理员权限' });
    return null;
  }
  return user;
}

async function ensureAdminUser() {
  const users = await readUsers();
  const existingIdx = users.findIndex(u => u.id === 'uadmin' || u.email === ADMIN_ACCOUNT.email || u.role === 'admin');
  if (existingIdx >= 0) {
    const existing = users[existingIdx];
    const fallbackPassword = existing.passwordHash ? {} : hashPassword(ADMIN_ACCOUNT.password, existing.passwordSalt);
    users[existingIdx] = {
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
  }
  await writeUsers(users);
}

await ensureAdminUser();

// ---------- 分组存储 ----------
async function readGroups() {
  if (!existsSync(GROUPS_FILE)) return [];
  try {
    const data = JSON.parse(await fs.readFile(GROUPS_FILE, 'utf8'));
    return Array.isArray(data) ? data : (data.groups || []);
  } catch (e) { return []; }
}

async function writeGroups(groups) {
  await fs.writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

// 计算目录总大小
async function getDirSize(dirPath) {
  let totalSize = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await getDirSize(fullPath);
    } else if (entry.isFile() && entry.name !== 'meta.json') {
      const stat = statSync(fullPath);
      totalSize += stat.size;
    }
  }
  return totalSize;
}

async function listPrototypeMetas() {
  const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const token = entry.name;
    const meta = await readMeta(token);
    if (!meta) continue;
    const dir = protoDir(token);
    const sizeBytes = await getDirSize(dir);
    items.push({ token, meta, dir, sizeBytes });
  }
  return items;
}

async function getUserUsage(userId) {
  const items = await listPrototypeMetas();
  const owned = items.filter(item => item.meta.ownerId === userId);
  return {
    projectCount: owned.length,
    storageBytes: owned.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

async function assertUserQuota(user, deltaBytes = 0, deltaProjects = 0) {
  if (!user) return { ok: true };
  const quota = user.quota || DEFAULT_QUOTA;
  const usage = await getUserUsage(user.id);
  if (quota.projectLimit >= 0 && usage.projectCount + deltaProjects > quota.projectLimit) {
    return { ok: false, error: `项目数量已达配额上限（${quota.projectLimit} 个）` };
  }
  if (quota.storageLimitBytes >= 0 && usage.storageBytes + deltaBytes > quota.storageLimitBytes) {
    return { ok: false, error: `空间已达配额上限（${formatSize(quota.storageLimitBytes)}）` };
  }
  return { ok: true, usage, quota };
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ---------- 路由处理 ----------
async function handleAPI(req, res, urlParts) {
  const pathname = urlParts.pathname;

  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // ===== 用户注册登录 API =====
  if (['/api/auth/send-code', '/api/auth/send-email-code', '/api/auth/email-code'].includes(pathname) && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) { sendJSON(res, 400, { error: '请输入有效邮箱' }); return; }
      const users = await readUsers();
      if (users.some(u => u.email === email)) { sendJSON(res, 409, { error: '该邮箱已注册' }); return; }
      const code = await createVerificationCode(email);
      const mail = await sendVerificationEmail(email, code);
      const payload = {
        ok: true,
        message: mail.sent ? 'MockLink验证码已发送，请查收邮箱' : '测试环境验证码已生成，有效期 10 分钟',
        mailSent: mail.sent,
        subject: mail.subject,
      };
      if (!mail.sent) payload.devCode = code;
      sendJSON(res, 200, {
        ...payload,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/auth/send-reset-code' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) { sendJSON(res, 400, { error: '请输入有效邮箱' }); return; }
      const users = await readUsers();
      if (!users.some(u => u.email === email)) { sendJSON(res, 404, { error: '该邮箱尚未注册' }); return; }
      const code = await createVerificationCode(email);
      const mail = await sendVerificationEmail(email, code);
      const payload = {
        ok: true,
        message: mail.sent ? 'MockLink重置密码验证码已发送，请查收邮箱' : '测试环境验证码已生成，有效期 10 分钟',
        mailSent: mail.sent,
        subject: mail.subject,
      };
      if (!mail.sent) payload.devCode = code;
      sendJSON(res, 200, {
        ...payload,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      const verificationCode = String(body.verificationCode || '').trim();
      const name = String(body.name || email.split('@')[0] || '新用户').trim();
      if (!isValidEmail(email)) { sendJSON(res, 400, { error: '请输入有效邮箱' }); return; }
      if (!verificationCode) { sendJSON(res, 400, { error: '请输入邮箱验证码' }); return; }
      if (password.length < 6) { sendJSON(res, 400, { error: '密码至少 6 位' }); return; }
      if (password !== confirmPassword) { sendJSON(res, 400, { error: '两次输入的密码不一致' }); return; }
      const codeOk = await verifyEmailCode(email, verificationCode);
      if (!codeOk) { sendJSON(res, 400, { error: '邮箱验证码错误或已过期' }); return; }
      const users = await readUsers();
      if (users.some(u => u.email === email)) { sendJSON(res, 409, { error: '该邮箱已注册' }); return; }
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
      sendJSON(res, 200, { token, user: publicUser(user) }, {
        'Set-Cookie': `wc_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      const verificationCode = String(body.verificationCode || '').trim();
      if (!isValidEmail(email)) { sendJSON(res, 400, { error: '请输入有效邮箱' }); return; }
      if (!verificationCode) { sendJSON(res, 400, { error: '请输入邮箱验证码' }); return; }
      if (password.length < 6) { sendJSON(res, 400, { error: '密码至少 6 位' }); return; }
      if (password !== confirmPassword) { sendJSON(res, 400, { error: '两次输入的密码不一致' }); return; }
      const users = await readUsers();
      const userIndex = users.findIndex(u => u.email === email);
      if (userIndex < 0) { sendJSON(res, 404, { error: '该邮箱尚未注册' }); return; }
      const codeOk = await verifyEmailCode(email, verificationCode);
      if (!codeOk) { sendJSON(res, 400, { error: '邮箱验证码错误或已过期' }); return; }
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
      sendJSON(res, 200, { ok: true, message: '密码已重置，请使用新密码登录' });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const users = await readUsers();
      const user = users.find(u => u.email === email);
      if (!user) { sendJSON(res, 401, { error: '邮箱或密码错误' }); return; }
      const { hash } = hashPassword(password, user.passwordSalt);
      if (hash !== user.passwordHash) { sendJSON(res, 401, { error: '邮箱或密码错误' }); return; }
      const token = crypto.randomBytes(24).toString('hex');
      const sessions = await readSessions();
      sessions.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
      await writeSessions(sessions);
      sendJSON(res, 200, { token, user: publicUser(user) }, {
        'Set-Cookie': `wc_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const cookieToken = parseCookies(req).wc_auth_token;
    const token = match ? match[1] : cookieToken;
    if (token) {
      const sessions = await readSessions();
      await writeSessions(sessions.filter(s => s.token !== token));
    }
    sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': 'wc_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) { sendJSON(res, 200, { user: null }); return; }
    const usage = await getUserUsage(user.id);
    sendJSON(res, 200, { user: publicUser(user), usage });
    return;
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const users = await readUsers();
    const data = [];
    for (const user of users) {
      const usage = await getUserUsage(user.id);
      data.push({ ...publicUser(user), usage });
    }
    sendJSON(res, 200, { users: data });
    return;
  }

  if (pathname === '/api/admin/users' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!name) { sendJSON(res, 400, { error: '姓名不能为空' }); return; }
      if (!email) { sendJSON(res, 400, { error: '账号不能为空' }); return; }
      if (password.length < 6) { sendJSON(res, 400, { error: '密码至少 6 位' }); return; }
      const users = await readUsers();
      if (users.some(u => u.email === email)) {
        sendJSON(res, 409, { error: '该账号已存在' });
        return;
      }
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
      sendJSON(res, 200, { user: publicUser(user), usage: await getUserUsage(user.id) });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === adminUserMatch[1]);
      if (idx < 0) { sendJSON(res, 404, { error: '用户不存在' }); return; }

      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!name) { sendJSON(res, 400, { error: '姓名不能为空' }); return; }
      if (!email) { sendJSON(res, 400, { error: '账号不能为空' }); return; }
      if (users.some((u, i) => i !== idx && u.email === email)) {
        sendJSON(res, 409, { error: '该账号已存在' });
        return;
      }
      if (password && password.length < 6) {
        sendJSON(res, 400, { error: '密码至少 6 位' });
        return;
      }

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
      sendJSON(res, 200, { user: publicUser(users[idx]), usage: await getUserUsage(users[idx].id) });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (adminUserMatch && req.method === 'DELETE') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const userId = adminUserMatch[1];
      if (userId === admin.id) {
        sendJSON(res, 400, { error: '不能删除当前登录账号' });
        return;
      }
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx < 0) { sendJSON(res, 404, { error: '用户不存在' }); return; }
      if ((users[idx].role || 'user') === 'admin') {
        const adminCount = users.filter(u => (u.role || 'user') === 'admin').length;
        if (adminCount <= 1) {
          sendJSON(res, 400, { error: '至少保留一个管理员账号' });
          return;
        }
      }
      const removed = users.splice(idx, 1)[0];
      await writeUsers(users);

      const sessions = await readSessions();
      await writeSessions(sessions.filter(s => s.userId !== userId));

      const items = await listPrototypeMetas();
      for (const item of items) {
        if (item.meta.ownerId === userId) {
          item.meta.ownerId = null;
          item.meta.updatedAt = new Date().toISOString();
          await writeMeta(item.token, item.meta);
        }
      }

      sendJSON(res, 200, { ok: true, user: publicUser(removed) });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  const quotaMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/quota$/);
  if (quotaMatch && req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === quotaMatch[1]);
      if (idx < 0) { sendJSON(res, 404, { error: '用户不存在' }); return; }
      const projectLimit = Number(body.projectLimit);
      const storageLimitMB = Number(body.storageLimitMB);
      users[idx].quota = {
        projectLimit: Number.isFinite(projectLimit) ? Math.max(-1, Math.floor(projectLimit)) : (users[idx].quota?.projectLimit ?? DEFAULT_QUOTA.projectLimit),
        storageLimitBytes: Number.isFinite(storageLimitMB) ? Math.max(-1, Math.floor(storageLimitMB * 1024 * 1024)) : (users[idx].quota?.storageLimitBytes ?? DEFAULT_QUOTA.storageLimitBytes),
      };
      await writeUsers(users);
      sendJSON(res, 200, { user: publicUser(users[idx]), usage: await getUserUsage(users[idx].id) });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ===== 分组管理 API =====

  // GET /api/groups — 列出所有分组
  if (pathname === '/api/groups' && req.method === 'GET') {
    try {
      const groups = await readGroups();
      sendJSON(res, 200, { groups });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/groups — 创建分组
  if (pathname === '/api/groups' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const name = (body.name || '').trim();
      if (!name) { sendJSON(res, 400, { error: '分组名称不能为空' }); return; }
      const groups = await readGroups();
      // 检查二级分组限制：如果 parentId 存在，其 parent 必须是顶级
      if (body.parentId) {
        const parent = groups.find(g => g.id === body.parentId);
        if (!parent) { sendJSON(res, 400, { error: '父分组不存在' }); return; }
        if (parent.parentId) { sendJSON(res, 400, { error: '最多支持二级分组' }); return; }
      }
      const group = {
        id: 'g' + crypto.randomBytes(4).toString('hex'),
        name,
        parentId: body.parentId || null,
        createdAt: new Date().toISOString(),
      };
      groups.push(group);
      await writeGroups(groups);
      sendJSON(res, 200, group);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // PUT /api/groups/:id — 更新分组（重命名/移动）
  const groupPutMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupPutMatch && req.method === 'PUT') {
    try {
      const id = groupPutMatch[1];
      const body = JSON.parse((await readBody(req)).toString());
      const groups = await readGroups();
      const idx = groups.findIndex(g => g.id === id);
      if (idx < 0) { sendJSON(res, 404, { error: '分组不存在' }); return; }
      if (body.name !== undefined) groups[idx].name = body.name.trim() || groups[idx].name;
      if (body.parentId !== undefined) {
        // 检查二级分组限制
        if (body.parentId) {
          if (body.parentId === id) { sendJSON(res, 400, { error: '不能将分组设为自身的子分组' }); return; }
          const parent = groups.find(g => g.id === body.parentId);
          if (!parent) { sendJSON(res, 400, { error: '父分组不存在' }); return; }
          if (parent.parentId) { sendJSON(res, 400, { error: '最多支持二级分组' }); return; }
        }
        groups[idx].parentId = body.parentId || null;
      }
      await writeGroups(groups);
      sendJSON(res, 200, groups[idx]);
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // DELETE /api/groups/:id — 删除分组
  if (groupPutMatch && req.method === 'DELETE') {
    try {
      const id = groupPutMatch[1];
      let groups = await readGroups();
      // 收集要删除的分组（包括子分组）
      const toDelete = new Set([id]);
      groups.forEach(g => { if (g.parentId === id) toDelete.add(g.id); });
      groups = groups.filter(g => !toDelete.has(g.id));
      await writeGroups(groups);
      // 将该分组下的原型设为未分组
      const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = await readMeta(entry.name);
        if (meta && toDelete.has(meta.groupId)) {
          meta.groupId = null;
          await writeMeta(entry.name, meta);
        }
      }
      sendJSON(res, 200, { ok: true, message: '已删除分组' });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/extension/download — 下载 Chrome 扩展 zip
  if (pathname === '/api/extension/download' && req.method === 'GET') {
    try {
      const tmpZip = path.join(tmpdir(), `extension_${Date.now()}.zip`);
      execSync(`cd "${path.dirname(EXTENSION_DIR)}" && zip -r "${tmpZip}" "${path.basename(EXTENSION_DIR)}/"`);
      const zipData = await fs.readFile(tmpZip);
      await fs.unlink(tmpZip).catch(() => {});
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="mocklink-extension.zip"',
        'Content-Length': zipData.length,
      });
      res.end(zipData);
    } catch (e) {
      sendJSON(res, 500, { error: '打包失败: ' + e.message });
    }
    return;
  }

  // GET /api/prototypes — 列出所有原型
  if (pathname === '/api/prototypes' && req.method === 'GET') {
    try {
      const currentUser = await getAuthUser(req);
      const users = await readUsers();
      const prototypes = [];
      for (const item of await listPrototypeMetas()) {
        const meta = item.meta;
        if (currentUser && currentUser.role !== 'admin' && meta.ownerId && meta.ownerId !== currentUser.id) continue;
        const owner = users.find(u => u.id === meta.ownerId);
        prototypes.push({
          token: meta.token,
          name: meta.name || '未命名原型',
          status: meta.status || 'unknown',
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt || meta.publishedAt || meta.createdAt,
          publishedAt: meta.publishedAt,
          fileCount: meta.fileCount || 0,
          size: formatSize(item.sizeBytes),
          sizeBytes: item.sizeBytes,
          hasIndex: meta.hasIndex !== undefined ? meta.hasIndex : existsSync(path.join(item.dir, 'index.html')),
          groupId: meta.groupId || null,
          ownerId: meta.ownerId || null,
          ownerName: owner ? (owner.name || owner.email) : '未归属',
        });
      }
      // 按更新时间倒序
      prototypes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      sendJSON(res, 200, { prototypes });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // PUT /api/prototypes/:token — 更新项目名称/分组
  const protoMatch = pathname.match(/^\/api\/prototypes\/([^/]+)$/);
  if (protoMatch && req.method === 'PUT') {
    try {
      const token = protoMatch[1];
      const meta = await readMeta(token);
      if (!meta) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = String(body.name || '').trim();
        if (!name) {
          sendJSON(res, 400, { error: '项目名称不能为空' });
          return;
        }
        meta.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'groupId')) {
        meta.groupId = body.groupId || null;
      }
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      sendJSON(res, 200, { ok: true, prototype: meta });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // DELETE /api/prototypes/:token — 删除原型
  if (protoMatch && req.method === 'DELETE') {
    try {
      const token = protoMatch[1];
      const dir = protoDir(token);
      if (!existsSync(path.join(dir, 'meta.json'))) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      await fs.rm(dir, { recursive: true, force: true });
      sendJSON(res, 200, { ok: true, message: '已删除' });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/prototypes/:token/clear — 清空 HTML（保留项目元数据）
  const clearMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/clear$/);
  if (clearMatch && req.method === 'POST') {
    try {
      const token = clearMatch[1];
      const dir = protoDir(token);
      const meta = await readMeta(token);
      if (!meta) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      // 清空目录内所有文件（保留 meta.json）
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'meta.json') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }
      meta.status = 'cleared';
      meta.fileCount = 0;
      meta.hasIndex = false;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      sendJSON(res, 200, { ok: true, message: '已清空 HTML' });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/prototypes — 创建原型
  if (pathname === '/api/prototypes' && req.method === 'POST') {
    try {
      const currentUser = await getAuthUser(req);
      const body = JSON.parse((await readBody(req)).toString());
      const projectName = String(body.name || '').trim();
      if (!projectName) {
        sendJSON(res, 400, { error: '项目名称不能为空' });
        return;
      }
      if (currentUser) {
        const quotaCheck = await assertUserQuota(currentUser, 0, 1);
        if (!quotaCheck.ok) { sendJSON(res, 403, { error: quotaCheck.error }); return; }
      }
      const token = crypto.randomBytes(6).toString('hex');
      const dir = protoDir(token);
      await fs.mkdir(dir, { recursive: true });
      const meta = {
        token,
        name: projectName,
        status: 'uploading',
        createdAt: new Date().toISOString(),
        fileCount: 0,
        entryPath: body.entryPath ? sanitizePath(body.entryPath) : '',
        groupId: body.groupId || null,
        ownerId: currentUser ? currentUser.id : null,
      };
      await writeMeta(token, meta);
      sendJSON(res, 200, { token, uploadUrl: `/api/prototypes/${token}/files` });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/prototypes/:token/files — 上传单个文件（JSON: { path, content: base64 }）
  const fileMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files$/);
  if (fileMatch && req.method === 'POST') {
    try {
      const token = fileMatch[1];
      const dir = protoDir(token);
      if (!existsSync(path.join(dir, 'meta.json'))) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString());
      const relPath = sanitizePath(body.path);
      if (!relPath || !body.content) {
        sendJSON(res, 400, { error: '缺少文件路径或内容' });
        return;
      }
      const meta = await readMeta(token);
      if (meta.ownerId) {
        const users = await readUsers();
        const owner = users.find(u => u.id === meta.ownerId);
        if (owner) {
          const incomingBytes = Buffer.byteLength(body.content, 'base64');
          const quotaCheck = await assertUserQuota(owner, incomingBytes, 0);
          if (!quotaCheck.ok) { sendJSON(res, 403, { error: quotaCheck.error }); return; }
        }
      }
      const dest = path.join(dir, relPath);
      if (!path.resolve(dest).startsWith(dir + path.sep)) {
        sendJSON(res, 403, { error: '非法路径' });
        return;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(body.content, 'base64'));

      meta.fileCount = (meta.fileCount || 0) + 1;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      sendJSON(res, 200, { ok: true, path: relPath });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  const batchFileMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/files\/batch$/);
  if (batchFileMatch && req.method === 'POST') {
    try {
      const token = batchFileMatch[1];
      const dir = protoDir(token);
      if (!existsSync(path.join(dir, 'meta.json'))) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString());
      const uploadFiles = Array.isArray(body.files) ? body.files : [];
      if (!uploadFiles.length) { sendJSON(res, 400, { error: '缺少文件列表' }); return; }
      if (uploadFiles.length > 80) { sendJSON(res, 400, { error: '单批文件数量过多' }); return; }
      const normalized = uploadFiles.map(item => ({
        path: sanitizePath(item.path),
        content: item.content || '',
      })).filter(item => item.path && item.content);
      if (!normalized.length) { sendJSON(res, 400, { error: '缺少有效文件' }); return; }

      const meta = await readMeta(token);
      const totalBytes = normalized.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'base64'), 0);
      if (meta.ownerId) {
        const users = await readUsers();
        const owner = users.find(u => u.id === meta.ownerId);
        if (owner) {
          const quotaCheck = await assertUserQuota(owner, totalBytes, 0);
          if (!quotaCheck.ok) { sendJSON(res, 403, { error: quotaCheck.error }); return; }
        }
      }

      for (const item of normalized) {
        const dest = path.join(dir, item.path);
        if (!path.resolve(dest).startsWith(dir + path.sep)) {
          sendJSON(res, 403, { error: '非法路径' });
          return;
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(item.content, 'base64'));
      }

      const allFiles = await listPrototypeFiles(dir);
      meta.fileCount = allFiles.length;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);
      sendJSON(res, 200, { ok: true, count: normalized.length, paths: normalized.map(item => item.path) });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/prototypes/:token/update — 更新原型（清空旧文件，保留 token 和分享路径）
  const updateMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    try {
      const token = updateMatch[1];
      const dir = protoDir(token);
      const meta = await readMeta(token);
      if (!meta) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      const currentUser = await getAuthUser(req);
      if (!meta.ownerId && currentUser) meta.ownerId = currentUser.id;
      // 读取请求体（可携带新名称）
      const rawBody = (await readBody(req)).toString();
      let newName = '';
      if (rawBody) {
        try { newName = JSON.parse(rawBody).name || ''; } catch (e) {}
      }

      // 清空目录内所有文件（保留 meta.json）
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'meta.json') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }

      // 更新元数据
      meta.status = 'updating';
      meta.fileCount = 0;
      meta.hasIndex = false;
      if (newName) meta.name = newName;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(token, meta);

      sendJSON(res, 200, {
        token,
        uploadUrl: `/api/prototypes/${token}/files`,
        shareUrl: `/s/${token}`,
        message: '已清空旧文件，可重新上传',
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/prototypes/:token/publish — 发布
  const pubMatch = pathname.match(/^\/api\/prototypes\/([^/]+)\/publish$/);
  if (pubMatch && req.method === 'POST') {
    try {
      const token = pubMatch[1];
      const meta = await readMeta(token);
      if (!meta) {
        sendJSON(res, 404, { error: '原型不存在' });
        return;
      }
      const dir = protoDir(token);
      let body = {};
      try {
        const rawBody = (await readBody(req)).toString();
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (e) {}

      const missingFiles = await validatePrototypeReferences(dir);
      if (missingFiles.length > 0) {
        sendJSON(res, 400, {
          error: `有 ${missingFiles.length} 个被引用的资源文件缺失，请重新上传完整 Axure 发布目录`,
          missingFiles: missingFiles.slice(0, 50),
        });
        return;
      }

      const requestedEntry = sanitizePath(body.entryPath || meta.entryPath || '');
      let entryPath = '';
      if (existsSync(path.join(dir, 'index.html'))) {
        entryPath = 'index.html';
      } else if (existsSync(path.join(dir, 'start.html'))) {
        entryPath = 'start.html';
      } else if (requestedEntry && existsSync(path.join(dir, requestedEntry))) {
        entryPath = requestedEntry;
      } else {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const firstHtml = entries
          .filter(entry => entry.isFile() && /\.html?$/i.test(entry.name))
          .map(entry => entry.name)
          .sort()[0];
        if (firstHtml) entryPath = firstHtml;
      }

      const hasIndex = !!entryPath;
      meta.status = 'ready';
      meta.hasIndex = hasIndex;
      meta.entryPath = entryPath;
      meta.publishedAt = new Date().toISOString();
      meta.updatedAt = meta.publishedAt;
      await writeMeta(token, meta);
      sendJSON(res, 200, {
        token,
        shareUrl: `/s/${token}`,
        viewUrl: `/v/${token}/`,
        hasIndex,
        entryPath,
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/prototypes/:token — 查询元数据
  const getMatch = pathname.match(/^\/api\/prototypes\/([^/]+)$/);
  if (getMatch && req.method === 'GET') {
    const meta = await readMeta(getMatch[1]);
    if (!meta) {
      sendJSON(res, 404, { error: '原型不存在' });
      return;
    }
    sendJSON(res, 200, meta);
    return;
  }

  sendJSON(res, 404, { error: 'API 不存在' });
}

// ---------- 分享与查看 ----------
async function handleShare(req, res, urlParts) {
  const pathname = urlParts.pathname;

  // /s/:token — 重定向到查看页
  const sMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (sMatch) {
    const meta = await readMeta(sMatch[1]);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>原型不存在或已删除</h1>');
      return;
    }
    res.writeHead(302, { Location: `/v/${sMatch[1]}/` });
    res.end();
    return;
  }

  // /v/:token 或 /v/:token/* — 分发静态文件
  const vMatch = pathname.match(/^\/v\/([^/]+)(.*)$/);
  if (vMatch) {
    const token = vMatch[1];
    const dir = protoDir(token);
    const meta = await readMeta(token);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>原型不存在</h1>');
      return;
    }
    let relPath = vMatch[2] || '';
    // 去掉开头的斜杠
    relPath = relPath.replace(/^\/+/, '');
    const isRootRequest = relPath === '' || relPath.endsWith('/');
    if (isRootRequest) relPath += 'index.html';
    // 解码 URL 编码的文件名（如中文文件名 %E9%A6%96%E9%A1%B5.html → 首页.html）
    try { relPath = decodeURIComponent(relPath); } catch (e) {}
    relPath = sanitizePath(relPath) || 'index.html';

    let filePath = path.join(dir, relPath);
    if (!path.resolve(filePath).startsWith(dir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>禁止访问</h1>');
      return;
    }
    // Axure 原型可能使用 start.html、当前同步页或任意 HTML 文件作为入口
    if (!existsSync(filePath) && relPath === 'index.html') {
      const startPath = path.join(dir, 'start.html');
      if (existsSync(startPath)) {
        filePath = startPath;
      } else if (meta.entryPath) {
        const entryPath = sanitizePath(meta.entryPath);
        const entryFile = path.join(dir, entryPath);
        if (entryPath && existsSync(entryFile)) {
          filePath = entryFile;
        }
      }
      if (!existsSync(filePath)) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const firstHtml = entries
          .filter(entry => entry.isFile() && /\.html?$/i.test(entry.name))
          .map(entry => entry.name)
          .sort()[0];
        if (firstHtml) filePath = path.join(dir, firstHtml);
      }
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>文件不存在</h1>');
      return;
    }
    const stat = statSync(filePath);
    res.writeHead(200, {
      'Content-Type': getMime(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  return false; // 未匹配
}

// ---------- 静态文件服务（public 目录）----------
async function serveStatic(req, res, urlParts) {
  let pathname = urlParts.pathname;
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/index.html') {
    const user = await getAuthUser(req);
    if (!user) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }
  }
  const filePath = path.join(PUBLIC_DIR, sanitizePath(pathname));
  if (!path.resolve(filePath).startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 Not Found</h1>');
    return;
  }
  const stat = statSync(filePath);
  const isHtml = /\.html?$/i.test(filePath);
  res.writeHead(200, {
    'Content-Type': getMime(filePath),
    'Content-Length': stat.size,
    'Cache-Control': isHtml ? 'no-store, no-cache, must-revalidate, max-age=0' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

// ---------- 主服务器 ----------
const server = http.createServer(async (req, res) => {
  const urlParts = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // API 路由
    if (urlParts.pathname.startsWith('/api/')) {
      await handleAPI(req, res, urlParts);
      return;
    }

    // 分享与查看路由
    if (urlParts.pathname.startsWith('/s/') || urlParts.pathname.startsWith('/v/')) {
      const handled = await handleShare(req, res, urlParts);
      if (handled !== false) return;
    }

    // 静态文件
    await serveStatic(req, res, urlParts);
  } catch (e) {
    console.error('请求处理错误:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`
  MockLink - Axure 原型托管服务已启动（零依赖）
  管理入口:  http://localhost:${PORT}
  API 基址:  http://localhost:${PORT}/api
  `);
});
