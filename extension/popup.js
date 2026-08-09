// MockLink Chrome 扩展 - 弹窗逻辑
// 检测 Axure 原型页面，一键同步到 MockLink

const DEFAULT_SERVER = 'http://localhost:3000';

// DOM 引用
const serverInput = document.getElementById('server');
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

// 状态
let detectedAxure = false;
let detectedName = null;
let isSyncing = false;
let projects = [];
let selectedProject = { mode: 'new', token: null, name: '' };

// ===== 初始化 =====
// 加载服务器地址
chrome.storage.local.get(['server'], (r) => {
  serverInput.value = r.server || DEFAULT_SERVER;
  updateSyncButtonText();
  loadProjects();
  detectCurrentTab();
});
serverInput.addEventListener('change', () => {
  chrome.storage.local.set({ server: serverInput.value.trim() });
  clearSelectedProject();
  loadProjects();
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
        detectedAxure = true;
        detectedName = response.name || '未命名原型';
        showDetectFound(detectedName);
        hintEl.textContent = '点击「一键同步」将当前原型上传到 MockLink';
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
  syncBtn.disabled = false;
}

function showDetectNotfound(msg) {
  detectStatus.className = 'detect-status not-found';
  detectStatus.innerHTML = '<div class="detect-icon"></div><span>' + escapeHtml(msg) + '</span>';
  syncBtn.disabled = true;
}

// ===== 项目选择 =====
async function loadProjects(selectToken) {
  const server = serverInput.value.trim().replace(/\/$/, '');
  if (!server) return;
  try {
    projectHint.textContent = '正在加载项目列表...';
    const res = await fetch(`${server}/api/prototypes`);
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

  const server = serverInput.value.trim().replace(/\/$/, '');
  if (!server) { showError('请填写服务器地址'); resetState(); return; }

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
      const res = await fetch(`${server}/api/prototypes/${updateToken}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: protoName })
      });
      if (!res.ok) throw new Error('更新失败: HTTP ' + res.status);
      token = updateToken;
    } else {
      const res = await fetch(`${server}/api/prototypes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: protoName })
      });
      if (!res.ok) throw new Error('创建失败: HTTP ' + res.status);
      token = (await res.json()).token;
    }

    // 3. 并发上传文件（带重试）
    showProgress('上传文件中...', 0, resources.length);
    let done = 0, failed = 0;
    const failedPaths = [];

    await pMap(resources, async (item) => {
      const relPath = typeof item === 'string' ? item : item.path;
      const sourceUrl = typeof item === 'string' ? new URL(item, baseUrl).href : item.url;
      let success = false;
      let lastReason = '';
      // 最多重试 2 次
      for (let attempt = 0; attempt < 2 && !success; attempt++) {
        try {
          // 使用 content script 已解析好的真实 URL，避免 file:// 中文、空格路径二次编码失败
          const fileUrl = sourceUrl || new URL(relPath, baseUrl).href;
          const fileRes = await fetch(fileUrl);
          if (!fileRes.ok) {
            lastReason = `HTTP ${fileRes.status}`;
            if (attempt === 1) { failed++; failedPaths.push(`${relPath}（${lastReason}）`); }
            continue;
          }

          const buffer = await fileRes.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
          }
          const b64 = btoa(chunks.join(''));

          const uploadRes = await fetch(`${server}/api/prototypes/${token}/files`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath, content: b64 })
          });
          if (uploadRes.ok) {
            success = true;
          } else if (attempt === 1) {
            let uploadReason = '上传接口错误';
            try {
              const errData = await uploadRes.json();
              uploadReason = errData.error || uploadReason;
            } catch (e) {
              uploadReason = `HTTP ${uploadRes.status}`;
            }
            failed++; failedPaths.push(`${relPath}（${uploadReason}）`);
          }
        } catch (e) {
          lastReason = e.message || '读取失败';
          if (attempt === 1) { failed++; failedPaths.push(`${relPath}（${lastReason}）`); }
        }
      }

      done++;
      showProgress(failed > 0 ? `上传中... (${failed} 失败)` : '上传文件中...', done, resources.length);
    }, 8);

    // 4. 发布
    showProgress('发布中...', resources.length, resources.length);
    const pubRes = await fetch(`${server}/api/prototypes/${token}/publish`, {
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
    progress.classList.remove('show');
    result.classList.add('show');
    shareInput.value = shareUrl;
    statusText.textContent = updateToken ? '项目更新完成！' : '新项目同步完成！';

    // 自动复制
    try {
      await navigator.clipboard.writeText(shareUrl);
      hintEl.textContent = '链接已自动复制到剪贴板' + (failed > 0 ? `（${failed} 个文件上传失败）` : '');
    } catch (e) {
      hintEl.textContent = failed > 0 ? `${failed} 个文件上传失败` : '';
    }
    if (failed > 0 && failedPaths.length > 0) {
      const sample = failedPaths.slice(0, 3).join('；');
      hintEl.textContent = `同步完成，但有 ${failed} 个资源未上传：${sample}`;
      console.warn('上传失败的文件:', failedPaths);
    }

    await loadProjects(token);

  } catch (e) {
    showError('同步失败: ' + e.message);
  } finally {
    resetState();
  }
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
  syncBtn.disabled = !detectedAxure;
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
