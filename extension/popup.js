// MockLink Chrome 扩展 - 弹窗逻辑
// 检测 Axure 原型页面，一键同步到 MockLink

const DEFAULT_SERVER = 'https://mocklink.netlify.app';

// DOM 引用
const projectInput = document.getElementById('projectInput');
const projectDropdown = document.getElementById('projectDropdown');
const projectClearBtn = document.getElementById('projectClearBtn');
const projectHint = document.getElementById('projectHint');
const detectStatus = document.getElementById('detectStatus');
const syncBtn = document.getElementById('syncBtn');
const syncLabel = document.getElementById('syncLabel');
const progress = document.getElementById('progress');
const bar = document.getElementById('bar');
const statusText = document.getElementById('statusText');
const doneCount = document.getElementById('doneCount');
const totalCount = document.getElementById('totalCount');
const result = document.getElementById('result');
const shareInput = document.getElementById('shareInput');
const errEl = document.getElementById('err');
const hintEl = document.getElementById('hint');
const versionText = document.getElementById('versionText');
const authCard = document.getElementById('authCard');
const authUserEl = document.getElementById('authUser');
const authBtn = document.getElementById('authBtn');
const revokeAuthBtn = document.getElementById('revokeAuthBtn');
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
if (versionText) versionText.textContent = EXTENSION_VERSION;

// 状态
let detectedAxure = false;
let detectedName = null;
let isSyncing = false;
let projects = [];
let selectedProject = { mode: 'new', token: null, name: '' };
let authToken = null;
let currentUser = null;

// ===== 初始化 =====
chrome.storage.local.get(['authToken'], async (r) => {
  authToken = r.authToken || await readPlatformCookieToken();
  await refreshAuthState();
  updateSyncButtonText();
  loadProjects();
  detectCurrentTab();
});

projectInput.addEventListener('focus', () => {
  renderProjectDropdown(projectInput.value);
  showProjectDropdown();
});
projectInput.addEventListener('input', () => {
  selectedProject = { mode: 'new', token: null, name: projectInput.value.trim() };
  projectClearBtn.classList.toggle('show', !!projectInput.value.trim());
  updateProjectHint();
  updateSyncButtonText();
  renderProjectDropdown(projectInput.value);
  showProjectDropdown();
});
projectClearBtn.addEventListener('click', () => {
  clearSelectedProject();
  renderProjectDropdown('');
  projectInput.focus();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.project-field')) hideProjectDropdown();
});

authBtn.addEventListener('click', async () => {
  const token = await readPlatformCookieToken();
  if (token) {
    authToken = token;
    await chrome.storage.local.set({ authToken });
    await refreshAuthState();
    await loadProjects();
    return;
  }
  chrome.tabs.create({ url: `${DEFAULT_SERVER}/login.html?from=extension` });
  hintEl.textContent = '请在打开的页面完成登录，登录后回到扩展点击「刷新授权」。';
  authBtn.textContent = '刷新授权';
});

revokeAuthBtn.addEventListener('click', async () => {
  await cancelAuthorization();
});

function getServer() {
  return DEFAULT_SERVER;
}

function withAuthHeaders(extra = {}) {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

async function apiFetch(path, options = {}) {
  const headers = withAuthHeaders(options.headers || {});
  return fetch(`${getServer()}${path}`, { ...options, headers });
}

function readPlatformCookieToken() {
  return new Promise(resolve => {
    if (!chrome.cookies) return resolve(null);
    chrome.cookies.get({ url: DEFAULT_SERVER, name: 'wc_auth_token' }, cookie => {
      resolve(cookie && cookie.value ? decodeURIComponent(cookie.value) : null);
    });
  });
}

async function refreshAuthState() {
  if (!authToken) authToken = await readPlatformCookieToken();
  if (!authToken) {
    currentUser = null;
    await chrome.storage.local.remove('authToken');
    renderAuthState();
    return false;
  }
  try {
    const res = await apiFetch('/api/auth/me');
    const data = await res.json();
    currentUser = data.user || null;
    if (!currentUser) {
      authToken = null;
      await chrome.storage.local.remove('authToken');
      renderAuthState();
      return false;
    }
    await chrome.storage.local.set({ authToken });
    renderAuthState();
    return true;
  } catch (e) {
    currentUser = null;
    renderAuthState('授权状态检查失败');
    return false;
  }
}

function renderAuthState(message = '') {
  if (currentUser) {
    authCard.classList.add('authed');
    authUserEl.textContent = currentUser.name || currentUser.email || '已授权账号';
    authBtn.textContent = '刷新授权';
    revokeAuthBtn.style.display = '';
    if (message) hintEl.textContent = message;
  } else {
    authCard.classList.remove('authed');
    authUserEl.textContent = '未授权';
    authBtn.textContent = '授权登录';
    revokeAuthBtn.style.display = 'none';
    hintEl.textContent = message || '请先授权登录 MockLink 账号，项目会同步到该账号下。';
  }
  syncBtn.disabled = !detectedAxure || !currentUser;
}

async function cancelAuthorization() {
  try {
    if (authToken) await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  authToken = null;
  currentUser = null;
  await chrome.storage.local.remove('authToken');
  if (chrome.cookies) {
    chrome.cookies.remove({ url: DEFAULT_SERVER, name: 'wc_auth_token' });
  }
  projects = [];
  clearSelectedProject();
  renderProjectDropdown('');
  renderAuthState('已取消授权。');
}

// ===== 检测当前页面是否为 Axure 原型 =====
async function detectCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      showDetectNotfound('无法获取当前页面');
      return;
    }

    // 检查是否是 file:// 或 http:// 页面
    if (!tab.url.startsWith('file://') && !tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
      showDetectNotfound('请在浏览器中打开 Axure 原型页面');
      hintEl.textContent = '提示：在 Axure RP 中「发布 → 本地」，然后在 Chrome 中打开生成的 index.html';
      return;
    }

    // 向 content script 发送检测消息
    chrome.tabs.sendMessage(tab.id, { type: 'CHECK_AXURE' }, (response) => {
      if (chrome.runtime.lastError) {
        // content script 未注入（可能页面刚加载）
        showDetectNotfound('未检测到 Axure 原型');
        hintEl.textContent = '请确保已打开 Axure 发布的 HTML 原型页面，并已在扩展设置中允许访问文件 URL';
        return;
      }

      if (response && response.isAxure) {
        if (response.collectorVersion && response.collectorVersion !== EXTENSION_VERSION) {
          detectedAxure = false;
          showDetectNotfound(`页面采集脚本仍是旧版本 ${response.collectorVersion}，请刷新 Axure 页面后再同步`);
          hintEl.textContent = `当前扩展版本 ${EXTENSION_VERSION}。重新安装或更新扩展后，必须刷新已打开的 Axure 原型页面。`;
          return;
        }
        detectedAxure = true;
        detectedName = response.name || '未命名原型';
        showDetectFound(detectedName);
        hintEl.textContent = currentUser ? '点击「一键同步」将当前原型上传到已授权账号。' : '请先授权登录 MockLink 账号。';
      } else {
        detectedAxure = false;
        showDetectNotfound('当前页面不是 Axure 原型');
        hintEl.textContent = '请先在浏览器中打开 Axure 发布的 HTML 原型页面';
      }
    });
  } catch (e) {
    showDetectNotfound('检测失败: ' + e.message);
  }
}

function showDetectFound(name) {
  detectStatus.className = 'detect-status found';
  detectStatus.innerHTML = '<div class="detect-icon"></div><span>检测到 Axure 原型：<b>' + escapeHtml(name) + '</b></span>';
  syncBtn.disabled = !currentUser;
}

function showDetectNotfound(msg) {
  detectStatus.className = 'detect-status not-found';
  detectStatus.innerHTML = '<div class="detect-icon"></div><span>' + escapeHtml(msg) + '</span>';
  syncBtn.disabled = true;
}

// ===== 项目选择 =====
async function loadProjects(selectToken) {
  if (!authToken) {
    projects = [];
    projectHint.textContent = '授权登录后可加载该账号下的项目列表。';
    renderProjectDropdown(projectInput.value);
    return;
  }
  try {
    projectHint.textContent = '正在加载项目列表...';
    const res = await apiFetch('/api/prototypes');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    projects = Array.isArray(data.prototypes) ? data.prototypes : [];
    if (selectToken) {
      const matched = projects.find(p => p.token === selectToken);
      if (matched) selectExistingProject(matched, false);
    } else {
      updateProjectHint();
    }
    renderProjectDropdown(projectInput.value);
  } catch (e) {
    projects = [];
    projectHint.textContent = '项目列表加载失败，可直接按新项目上传。';
    renderProjectDropdown(projectInput.value);
  }
}

function renderProjectDropdown(keyword = '') {
  const q = String(keyword || '').trim().toLowerCase();
  const matched = projects.filter(p => {
    const name = String(p.name || '').toLowerCase();
    const token = String(p.token || '').toLowerCase();
    return !q || name.includes(q) || token.includes(q);
  }).slice(0, 20);

  const createName = projectInput.value.trim() || detectedName || '当前原型';
  const items = matched.map(p => `
    <div class="project-option ${selectedProject.token === p.token ? 'selected' : ''}" data-token="${escapeHtml(p.token)}">
      <span class="name">${escapeHtml(p.name || '未命名项目')}</span>
      <span class="meta">更新</span>
    </div>
  `).join('');

  projectDropdown.innerHTML = `
    ${items || '<div class="project-empty">未找到匹配项目</div>'}
    <div class="project-option create" data-create="1">
      <span class="name">＋ 新建项目：${escapeHtml(createName)}</span>
      <span class="meta">上传</span>
    </div>
  `;

  projectDropdown.querySelectorAll('[data-token]').forEach(el => {
    el.addEventListener('click', () => {
      const token = el.getAttribute('data-token');
      const project = projects.find(p => p.token === token);
      if (project) selectExistingProject(project);
    });
  });
  const createEl = projectDropdown.querySelector('[data-create]');
  if (createEl) {
    createEl.addEventListener('click', () => selectNewProject(projectInput.value.trim()));
  }
}

function showProjectDropdown() {
  projectInput.classList.add('active');
  projectDropdown.classList.add('show');
}

function hideProjectDropdown() {
  projectInput.classList.remove('active');
  projectDropdown.classList.remove('show');
}

function selectExistingProject(project, hide = true) {
  selectedProject = { mode: 'existing', token: project.token, name: project.name || '未命名项目' };
  projectInput.value = selectedProject.name;
  projectClearBtn.classList.add('show');
  updateProjectHint();
  renderProjectDropdown(projectInput.value);
  updateSyncButtonText();
  if (hide) hideProjectDropdown();
}

function selectNewProject(name, hide = true) {
  selectedProject = { mode: 'new', token: null, name: (name || '').trim() };
  projectInput.value = selectedProject.name;
  projectClearBtn.classList.toggle('show', !!selectedProject.name);
  updateProjectHint();
  updateSyncButtonText();
  if (hide) hideProjectDropdown();
}

function clearSelectedProject() {
  selectedProject = { mode: 'new', token: null, name: '' };
  projectInput.value = '';
  projectClearBtn.classList.remove('show');
  updateProjectHint();
  updateSyncButtonText();
}

function updateProjectHint() {
  if (selectedProject.mode === 'existing') {
    projectHint.textContent = `将更新已有项目「${selectedProject.name}」，分享链接保持不变。`;
  } else {
    projectHint.textContent = '将作为新项目上传；也可以搜索并选择已有项目进行更新。';
  }
}

function updateSyncButtonText() {
  const label = selectedProject.mode === 'existing' ? '更新到选中项目' : '新建项目并同步';
  syncLabel.textContent = label;
}

// ===== 一键同步 =====
syncBtn.addEventListener('click', async () => {
  if (isSyncing) return;
  const project = selectedProject && selectedProject.mode === 'existing'
    ? selectedProject
    : { mode: 'new', token: null, name: projectInput.value.trim() };

  await startSync(project);
});

async function startSync(project) {
  isSyncing = true;
  errEl.classList.remove('show');
  result.classList.remove('show');
  syncBtn.disabled = true;

  const server = getServer();
  if (!await refreshAuthState()) {
    showError('请先授权登录 MockLink 账号');
    resetState();
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showError('无法获取当前标签页'); resetState(); return; }

    // 1. 收集资源
    showProgress('正在收集原型文件...', 0, 0);

    const collectResponse = await chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_RESOURCES' });

    if (chrome.runtime.lastError || !collectResponse || !collectResponse.success) {
      showError('收集文件失败: ' + (collectResponse?.error || chrome.runtime.lastError?.message || '未知错误'));
      resetState();
      return;
    }

    if (collectResponse.collectorVersion !== EXTENSION_VERSION) {
      showError(`页面采集脚本版本不一致（页面 ${collectResponse.collectorVersion || '旧版本'}，扩展 ${EXTENSION_VERSION}）。请刷新 Axure 页面后再同步。`);
      resetState();
      return;
    }

    const { baseUrl, resources, name, entryPath } = collectResponse;
    const protoName = project.mode === 'new'
      ? (project.name || name || detectedName || '未命名原型')
      : (project.name || name || detectedName || '未命名原型');

    if (!resources || resources.length === 0) {
      showError('未找到任何原型文件');
      resetState();
      return;
    }

    // 2. 创建原型或更新
    const updateToken = project.mode === 'existing' ? project.token : null;
    showProgress(updateToken ? '清空旧项目文件...' : '创建新项目...', 0, resources.length);

    let token;
    if (updateToken) {
      const res = await apiFetch(`/api/prototypes/${updateToken}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: protoName })
      });
      if (!res.ok) throw new Error('更新失败: HTTP ' + res.status);
      token = updateToken;
    } else {
      const res = await apiFetch('/api/prototypes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: protoName })
      });
      if (!res.ok) throw new Error('创建失败: HTTP ' + res.status);
      token = (await res.json()).token;
    }

    // 3. 批量上传文件（带重试）
    showProgress('上传文件中...', 0, resources.length);
    const { failed, failedPaths, skipped, skippedPaths } = await uploadResourcesInBatches({
      resources,
      baseUrl,
      server,
      token,
      onProgress(done, total, failedCount) {
        showProgress(failedCount > 0 ? `上传中... (${failedCount} 失败)` : '上传文件中...', done, total);
      },
    });

    if (failed > 0) {
      const sample = failedPaths.slice(0, 5).join('；');
      throw new Error(`有 ${failed} 个资源上传失败，已停止发布。失败示例：${sample}`);
    }

    if (skipped > 0) {
      console.warn(`[MockLink] ${skipped} 个资源在原型中不存在（404），已跳过：`, skippedPaths);
    }

    // 4. 发布
    showProgress('文件已全部上传，正在发布...', resources.length, resources.length);
    const pubRes = await apiFetch(`/api/prototypes/${token}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryPath })
    });
    if (!pubRes.ok) {
      let reason = 'HTTP ' + pubRes.status;
      try {
        const errData = await pubRes.json();
        reason = errData.error || reason;
      } catch (e) {}
      throw new Error('发布失败: ' + reason);
    }
    const pubData = await pubRes.json();
    if (!pubData.hasIndex) {
      throw new Error('发布失败：未找到可作为入口的 HTML 文件，请确认当前打开的是 Axure 发布目录内的页面');
    }

    const shareUrl = server + pubData.shareUrl;

    // 5. 显示结果
    showProgress('同步成功！', resources.length, resources.length);
    progress.classList.remove('show');
    result.classList.add('show');
    shareInput.value = shareUrl;
    statusText.textContent = '同步成功！';

    // 自动复制
    let hintMsg = '链接已自动复制到剪贴板';
    if (skipped > 0) {
      hintMsg += `（${skipped} 个不存在的资源已跳过）`;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      hintEl.textContent = hintMsg;
    } catch (e) {
      hintEl.textContent = skipped > 0 ? `${skipped} 个不存在的资源已跳过` : '';
    }

    await loadProjects(token);

  } catch (e) {
    showError('同步失败: ' + e.message);
  } finally {
    resetState();
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

async function fetchResourceAsUploadFile(item, baseUrl) {
  const path = typeof item === 'string' ? item : item.path;
  const sourceUrl = typeof item === 'string' ? new URL(item, baseUrl).href : item.url;
  const fileUrl = sourceUrl || new URL(path, baseUrl).href;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    const err = new Error(`HTTP ${fileRes.status}`);
    err.statusCode = fileRes.status;
    err.isNotFound = fileRes.status === 404;
    throw err;
  }
  const buffer = await fileRes.arrayBuffer();
  return {
    path,
    content: arrayBufferToBase64(buffer),
    size: buffer.byteLength,
  };
}

function isIgnorableMissingPrototypeResource(relPath) {
  const p = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/^\/+/, '')
    .toLowerCase();
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

async function postJSONWithRetry(url, body, retries = 3) {
  let lastError = '';
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      try {
        const data = await res.json();
        lastError = data.error || `HTTP ${res.status}`;
      } catch (e) {
        lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastError = e.message || '网络错误';
    }
    if (attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw new Error(lastError || '上传接口错误');
}

async function uploadResourcesInBatches({ resources, baseUrl, server, token, onProgress }) {
  const maxBatchBytes = 1.5 * 1024 * 1024;
  const maxBatchFiles = 40;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  const failedPaths = [];
  const skippedPaths = [];
  const fetchedFiles = [];
  const batches = [];
  let current = [];
  let currentBytes = 0;

  function flushBatch() {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentBytes = 0;
  }

  await pMap(resources, async (item, index) => {
    const path = typeof item === 'string' ? item : item.path;
    try {
      const file = await fetchResourceAsUploadFile(item, baseUrl);
      fetchedFiles.push({ ...file, order: index });
    } catch (e) {
      if (e.isNotFound && isIgnorableMissingPrototypeResource(path)) {
        skipped++;
        skippedPaths.push(path);
      } else {
        failed++;
        failedPaths.push(`${path}（${e.message || '读取失败'}）`);
      }
    }
  }, 6);

  fetchedFiles.sort((a, b) => a.order - b.order);
  for (const file of fetchedFiles) {
    if (file.size > maxBatchBytes) {
      flushBatch();
      batches.push([file]);
    } else {
      if (current.length >= maxBatchFiles || currentBytes + file.size > maxBatchBytes) flushBatch();
      current.push(file);
      currentBytes += file.size;
    }
  }
  flushBatch();

  for (const batch of batches) {
    try {
      if (batch.length === 1 && batch[0].size > maxBatchBytes) {
        await postJSONWithRetry(`${server}/api/prototypes/${token}/files`, {
          path: batch[0].path,
          content: batch[0].content,
        });
      } else {
        await postJSONWithRetry(`${server}/api/prototypes/${token}/files/batch`, {
          files: batch.map(({ path, content }) => ({ path, content })),
        });
      }
      done += batch.length;
    } catch (e) {
      failed += batch.length;
      batch.forEach(file => failedPaths.push(`${file.path}（${e.message || '上传失败'}）`));
      done += batch.length;
    }
    onProgress(done, resources.length, failed);
  }

  return { failed, failedPaths, skipped, skippedPaths };
}

// ===== 并发控制 =====
async function pMap(items, fn, concurrency = 5) {
  let i = 0;
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// ===== UI 辅助 =====
function showProgress(text, done, total) {
  progress.classList.add('show');
  statusText.textContent = text;
  doneCount.textContent = done;
  totalCount.textContent = total || done;
  if (total > 0) {
    bar.style.width = (done / total * 100) + '%';
  }
}

function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.add('show');
  setTimeout(() => errEl.classList.remove('show'), 8000);
}

function resetState() {
  isSyncing = false;
  syncBtn.disabled = !detectedAxure || !currentUser;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 结果按钮 =====
document.getElementById('copyBtn').addEventListener('click', () => {
  shareInput.select();
  navigator.clipboard.writeText(shareInput.value);
});

document.getElementById('openBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: shareInput.value });
});
