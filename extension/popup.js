// MockLink Chrome 扩展 - 弹窗逻辑
// 检测 Axure 原型页面，一键同步到 MockLink
// 上传逻辑已迁移至 background.js (Service Worker)，popup 仅负责 UI 和状态显示

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
let projects = [];
let selectedProject = { mode: 'new', token: null, name: '' };
let authToken = null;
let currentUser = null;
let currentSyncState = null; // 缓存同步状态，用于判断是否正在同步

// ===== 初始化 =====
chrome.storage.local.get(['authToken', 'syncState'], async (r) => {
  authToken = r.authToken || await readPlatformCookieToken();
  await refreshAuthState();
  updateSyncButtonText();

  // 恢复同步状态（popup 重新打开时）
  if (r.syncState) {
    renderSyncState(r.syncState);
  }

  loadProjects();
  detectCurrentTab();
});

// 监听 storage 变化，实时更新 UI（popup 打开时）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.syncState) {
    renderSyncState(changes.syncState.newValue);
  }
});

// ===== 同步状态渲染 =====
function renderSyncState(state) {
  currentSyncState = state;
  if (!state) {
    // 清除状态
    progress.classList.remove('show');
    result.classList.remove('show');
    errEl.classList.remove('show');
    syncBtn.disabled = !detectedAxure || !currentUser;
    return;
  }

  switch (state.state) {
    case 'collecting':
    case 'checking':
      progress.classList.add('show');
      result.classList.remove('show');
      errEl.classList.remove('show');
      syncBtn.disabled = true;
      statusText.textContent = state.message || '正在收集原型文件...';
      doneCount.textContent = '0';
      totalCount.textContent = '0';
      bar.style.width = '0%';
      break;

    case 'uploading':
      progress.classList.add('show');
      result.classList.remove('show');
      errEl.classList.remove('show');
      syncBtn.disabled = true;
      statusText.textContent = state.message || '上传文件中...';
      {
        const done = state.progress?.done || 0;
        const total = state.progress?.total || 0;
        const failed = state.progress?.failed || 0;
        doneCount.textContent = String(done);
        totalCount.textContent = String(total);
        if (total > 0) {
          bar.style.width = (done / total * 100) + '%';
        }
      }
      break;

    case 'publishing':
      progress.classList.add('show');
      result.classList.remove('show');
      errEl.classList.remove('show');
      syncBtn.disabled = true;
      statusText.textContent = state.message || '正在发布...';
      {
        const total = state.progress?.total || 0;
        doneCount.textContent = String(total);
        totalCount.textContent = String(total);
        bar.style.width = '100%';
      }
      break;

    case 'done':
      progress.classList.remove('show');
      result.classList.add('show');
      errEl.classList.remove('show');
      syncBtn.disabled = !detectedAxure || !currentUser;
      shareInput.value = state.shareUrl || '';
      statusText.textContent = '同步成功！';

      // 自动复制
      if (state.shareUrl) {
        navigator.clipboard.writeText(state.shareUrl).catch(() => {});
      }

      // 显示增量跳过信息
      if (state.skippedFiles > 0) {
        hintEl.textContent = `增量更新：跳过 ${state.skippedFiles} 个未变更文件，链接已自动复制到剪贴板`;
      } else {
        hintEl.textContent = '链接已自动复制到剪贴板';
      }

      // 刷新项目列表
      loadProjects();
      break;

    case 'error':
      progress.classList.remove('show');
      result.classList.remove('show');
      errEl.classList.add('show');
      errEl.textContent = state.message || '同步失败';
      syncBtn.disabled = !detectedAxure || !currentUser;
      setTimeout(() => errEl.classList.remove('show'), 8000);
      break;
  }
}

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
  await chrome.runtime.sendMessage({ type: 'START_AUTH' });
  hintEl.textContent = '请在打开的页面完成登录；成功后会自动关闭登录页并回到原页面。';
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
    authBtn.style.display = 'none';
    revokeAuthBtn.style.display = '';
    if (message) hintEl.textContent = message;
  } else {
    authCard.classList.remove('authed');
    authUserEl.textContent = '未授权';
    authBtn.style.display = '';
    authBtn.textContent = '授权登录';
    revokeAuthBtn.style.display = 'none';
    hintEl.textContent = message || '请先授权登录 MockLink 账号，项目会同步到该账号下。';
  }
  // 不覆盖正在同步中的状态
  if (!currentSyncState || currentSyncState.state === 'done' || currentSyncState.state === 'error') {
    syncBtn.disabled = !detectedAxure || !currentUser;
  }
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
  // 不覆盖正在同步中的状态
  if (!currentSyncState || currentSyncState.state === 'done' || currentSyncState.state === 'error') {
    syncBtn.disabled = !currentUser;
  }
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

// ===== 一键同步（发消息给 Service Worker） =====
syncBtn.addEventListener('click', async () => {
  // 检查是否正在同步
  const { syncState } = await chrome.storage.local.get(['syncState']);
  if (syncState && ['collecting', 'checking', 'uploading', 'publishing'].includes(syncState.state)) {
    return; // 正在同步中，忽略
  }

  const project = selectedProject && selectedProject.mode === 'existing'
    ? selectedProject
    : { mode: 'new', token: null, name: projectInput.value.trim() };

  await startSync(project);
});

async function startSync(project) {
  errEl.classList.remove('show');
  result.classList.remove('show');
  syncBtn.disabled = true;

  if (!await refreshAuthState()) {
    showError('请先授权登录 MockLink 账号');
    syncBtn.disabled = !detectedAxure || !currentUser;
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showError('无法获取当前标签页');
      syncBtn.disabled = !detectedAxure || !currentUser;
      return;
    }

    // 发送消息给 background.js (Service Worker) 开始同步
    // 上传逻辑在 SW 中执行，popup 关闭也不影响
    chrome.runtime.sendMessage(
      {
        type: 'START_SYNC',
        tabId: tab.id,
        project,
        authToken,
      },
      (response) => {
        // response 在 SW 完成或失败后返回
        // 但 UI 更新已通过 storage.onChanged 实时处理
        if (chrome.runtime.lastError) {
          showError('同步启动失败: ' + chrome.runtime.lastError.message);
          syncBtn.disabled = !detectedAxure || !currentUser;
        }
      }
    );
  } catch (e) {
    showError('同步失败: ' + e.message);
    syncBtn.disabled = !detectedAxure || !currentUser;
  }
}

// ===== UI 辅助 =====
function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.add('show');
  setTimeout(() => errEl.classList.remove('show'), 8000);
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
