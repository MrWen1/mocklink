const MOCKLINK_SERVER = 'https://mocklink.netlify.app';

let authFlow = null;
let authCheckTimer = null;

// ===== Auth 逻辑（保留原有） =====
function readPlatformCookieToken() {
  return new Promise(resolve => {
    chrome.cookies.get({ url: MOCKLINK_SERVER, name: 'wc_auth_token' }, cookie => {
      resolve(cookie && cookie.value ? decodeURIComponent(cookie.value) : null);
    });
  });
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${MOCKLINK_SERVER}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch (e) {
    return null;
  }
}

async function completeAuthIfReady() {
  if (!authFlow) return false;
  const token = await readPlatformCookieToken();
  const user = await verifyToken(token);
  if (!token || !user) return false;

  await chrome.storage.local.set({ authToken: token });

  const { loginTabId, originTabId } = authFlow;
  authFlow = null;
  if (authCheckTimer) {
    clearInterval(authCheckTimer);
    authCheckTimer = null;
  }

  if (loginTabId) {
    chrome.tabs.remove(loginTabId).catch(() => {});
  }
  if (originTabId) {
    chrome.tabs.update(originTabId, { active: true }).catch(() => {});
  }
  return true;
}

function startAuthPolling() {
  if (authCheckTimer) clearInterval(authCheckTimer);
  authCheckTimer = setInterval(() => {
    completeAuthIfReady().catch(() => {});
  }, 1200);
}

// ===== API 辅助 =====
function getServer() {
  return MOCKLINK_SERVER;
}

function withAuthHeaders(extra = {}) {
  // 在 SW 中同步获取 token 不方便，由调用方传入
  return extra;
}

async function apiFetch(path, options = {}, authToken) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(`${getServer()}${path}`, { ...options, headers });
}

// ===== 上传辅助函数（从 popup.js 迁移） =====
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

async function computeFileHash(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
  const hash = await computeFileHash(buffer);
  return {
    path,
    content: arrayBufferToBase64(buffer),
    size: buffer.byteLength,
    hash,
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

async function postJSONWithRetry(url, body, authToken, retries = 3) {
  let lastError = '';
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
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

// ===== 并发控制 =====
async function pMap(items, fn, concurrency = 5) {
  let i = 0;
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// ===== 同步状态管理 =====
async function updateSyncState(state) {
  await chrome.storage.local.set({ syncState: state });
}

async function updateBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

async function notifySyncComplete(success, projectName, shareUrl) {
  try {
    if (success) {
      await chrome.notifications.create('sync-complete', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'MockLink 同步成功',
        message: `「${projectName || '原型'}」已同步完成${shareUrl ? '，点击扩展查看分享链接' : ''}`,
        priority: 2,
      });
    } else {
      await chrome.notifications.create('sync-failed', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'MockLink 同步失败',
        message: `「${projectName || '原型'}」同步失败，点击扩展查看详情`,
        priority: 2,
      });
    }
  } catch (e) {}
}

// ===== 增量更新：获取服务端已有文件清单 =====
async function getExistingFiles(token, authToken) {
  try {
    const res = await apiFetch(`/api/prototypes/${token}/files`, {}, authToken);
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch (e) {
    return [];
  }
}

// ===== 优化后的批量上传（并行批次 + 更大批次） =====
async function uploadResourcesInBatches({ resources, baseUrl, server, token, authToken, onProgress, existingFilesMap }) {
  const maxBatchBytes = 3 * 1024 * 1024;  // 3MB（原 1.5MB）
  const maxBatchFiles = 80;                // 80 文件（原 40，匹配服务端上限）
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let skippedIncremental = 0;
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

  // 阶段 1：并行预取文件内容（并发度 10）
  await pMap(resources, async (item) => {
    const path = typeof item === 'string' ? item : item.path;
    try {
      const file = await fetchResourceAsUploadFile(item, baseUrl);

      // 增量更新：跳过 hash 匹配的文件
      if (existingFilesMap) {
        const existing = existingFilesMap.get(path);
        if (existing && existing.hash && existing.hash === file.hash) {
          skippedIncremental++;
          done++;
          onProgress(done, resources.length, failed);
          return;
        }
      }

      fetchedFiles.push(file);
    } catch (e) {
      if (e.isNotFound && isIgnorableMissingPrototypeResource(path)) {
        skipped++;
        skippedPaths.push(path);
        done++;
        onProgress(done, resources.length, failed);
      } else {
        failed++;
        failedPaths.push(`${path}（${e.message || '读取失败'}）`);
        done++;
        onProgress(done, resources.length, failed);
      }
    }
  }, 10);  // 并发度 10（原 6）

  // 阶段 2：分批
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

  // 阶段 3：并行上传批次（并发度 3）
  let batchDone = skippedIncremental + skipped + failed;
  await pMap(batches, async (batch) => {
    try {
      if (batch.length === 1 && batch[0].size > maxBatchBytes) {
        await postJSONWithRetry(`${server}/api/prototypes/${token}/files`, {
          path: batch[0].path,
          content: batch[0].content,
        }, authToken);
      } else {
        await postJSONWithRetry(`${server}/api/prototypes/${token}/files/batch`, {
          files: batch.map(({ path, content }) => ({ path, content })),
        }, authToken);
      }
      batchDone += batch.length;
    } catch (e) {
      failed += batch.length;
      batch.forEach(file => failedPaths.push(`${file.path}（${e.message || '上传失败'}）`));
      batchDone += batch.length;
    }
    onProgress(batchDone, resources.length, failed);
  }, 3);  // 3 批并发（原串行）

  done = batchDone;
  return { failed, failedPaths, skipped, skippedPaths, skippedIncremental };
}

// ===== 主同步流程 =====
async function handleStartSync(message, sendResponse) {
  const { tabId, project, authToken } = message;

  const syncState = {
    state: 'collecting',
    progress: { done: 0, total: 0, failed: 0 },
    message: '正在收集原型文件...',
    shareUrl: null,
    error: null,
    startTime: Date.now(),
    projectName: project.name || '未命名原型',
    incremental: false,
    skippedFiles: 0,
  };
  await updateSyncState(syncState);
  await updateBadge('···', '#fa8c16');

  try {
    // 1. 收集资源
    const collectResponse = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_RESOURCES' });

    if (chrome.runtime.lastError || !collectResponse || !collectResponse.success) {
      throw new Error('收集文件失败: ' + (collectResponse?.error || chrome.runtime.lastError?.message || '未知错误'));
    }

    const { baseUrl, resources, name, entryPath } = collectResponse;
    const protoName = project.name || name || '未命名原型';
    syncState.projectName = protoName;

    if (!resources || resources.length === 0) {
      throw new Error('未找到任何原型文件');
    }

    syncState.progress.total = resources.length;
    syncState.message = `准备上传 ${resources.length} 个文件...`;
    await updateSyncState(syncState);

    // 2. 创建原型或增量更新
    const updateToken = project.mode === 'existing' ? project.token : null;
    let token;
    let existingFilesMap = null;

    if (updateToken) {
      // 增量更新：获取已有文件清单
      syncState.message = '检查已有文件...';
      syncState.state = 'checking';
      await updateSyncState(syncState);

      const existingFiles = await getExistingFiles(updateToken, authToken);
      if (existingFiles.length > 0) {
        existingFilesMap = new Map(existingFiles.map(f => [f.path, f]));
        syncState.incremental = true;
        syncState.message = `增量更新：${existingFiles.length} 个已有文件，比对中...`;
      } else {
        // 服务端无文件，走全量更新
        syncState.message = '全量更新：清空旧文件...';
        const res = await apiFetch(`/api/prototypes/${updateToken}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: protoName }),
        }, authToken);
        if (!res.ok) throw new Error('更新失败: HTTP ' + res.status);
      }
      token = updateToken;
    } else {
      // 新建项目
      syncState.message = '创建新项目...';
      const res = await apiFetch('/api/prototypes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: protoName }),
      }, authToken);
      if (!res.ok) throw new Error('创建失败: HTTP ' + res.status);
      token = (await res.json()).token;
    }

    // 3. 批量上传文件
    syncState.state = 'uploading';
    syncState.message = '上传文件中...';
    await updateSyncState(syncState);
    await updateBadge('↑', '#3f8d61');

    const { failed, failedPaths, skipped, skippedPaths, skippedIncremental } = await uploadResourcesInBatches({
      resources,
      baseUrl,
      server: getServer(),
      token,
      authToken,
      existingFilesMap,
      onProgress(done, total, failedCount) {
        syncState.progress = { done, total, failed: failedCount };
        syncState.message = failedCount > 0
          ? `上传中... ${done}/${total}（${failedCount} 失败）`
          : `上传中... ${done}/${total}`;
        const pct = total > 0 ? Math.round(done / total * 100) : 0;
        updateBadge(String(pct > 99 ? 99 : pct), '#3f8d61');
        updateSyncState(syncState);
      },
    });

    syncState.skippedFiles = skippedIncremental;

    if (failed > 0) {
      const sample = failedPaths.slice(0, 5).join('；');
      throw new Error(`有 ${failed} 个资源上传失败。失败示例：${sample}`);
    }

    // 4. 增量更新：删除已移除的文件
    if (existingFilesMap) {
      const localPaths = new Set(resources.map(r => typeof r === 'string' ? r : r.path));
      const removedPaths = Array.from(existingFilesMap.keys()).filter(p => !localPaths.has(p));
      if (removedPaths.length > 0) {
        syncState.message = `清理 ${removedPaths.length} 个已移除文件...`;
        await updateSyncState(syncState);
        await postJSONWithRetry(`${getServer()}/api/prototypes/${token}/files/delete`, {
          paths: removedPaths,
        }, authToken);
      }
    }

    // 5. 发布
    syncState.state = 'publishing';
    syncState.message = '正在发布...';
    syncState.progress = { done: resources.length, total: resources.length, failed: 0 };
    await updateSyncState(syncState);
    await updateBadge('99', '#3f8d61');

    const pubRes = await apiFetch(`/api/prototypes/${token}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryPath }),
    }, authToken);

    if (!pubRes.ok) {
      let reason = 'HTTP ' + pubRes.status;
      try { const errData = await pubRes.json(); reason = errData.error || reason; } catch (e) {}
      throw new Error('发布失败: ' + reason);
    }

    const pubData = await pubRes.json();
    if (!pubData.hasIndex) {
      throw new Error('发布失败：未找到可作为入口的 HTML 文件');
    }

    const shareUrl = getServer() + pubData.shareUrl;

    // 6. 完成
    syncState.state = 'done';
    syncState.message = '同步成功！';
    syncState.shareUrl = shareUrl;
    syncState.endTime = Date.now();
    await updateSyncState(syncState);
    await updateBadge('✓', '#18B26B');
    await notifySyncComplete(true, protoName, shareUrl);

    sendResponse({ ok: true, shareUrl });
  } catch (e) {
    syncState.state = 'error';
    syncState.error = e.message;
    syncState.message = '同步失败: ' + e.message;
    syncState.endTime = Date.now();
    await updateSyncState(syncState);
    await updateBadge('!', '#e8463a');
    await notifySyncComplete(false, syncState.projectName, null);

    sendResponse({ ok: false, error: e.message });
  }
}

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_AUTH') {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const originTabId = tabs[0] ? tabs[0].id : null;
      const tab = await chrome.tabs.create({
        url: `${MOCKLINK_SERVER}/login.html?from=extension`,
        active: true,
      });
      authFlow = { originTabId, loginTabId: tab.id };
      startAuthPolling();
      sendResponse({ ok: true });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'START_SYNC') {
    handleStartSync(message, sendResponse);
    return true;  // 异步响应
  }

  if (message.type === 'CLEAR_SYNC_STATE') {
    updateSyncState(null).then(() => {
      updateBadge('', null);
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ===== 通知点击：打开分享链接 =====
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.storage.local.get(['syncState'], (r) => {
    if (r.syncState && r.syncState.shareUrl) {
      chrome.tabs.create({ url: r.syncState.shareUrl });
    }
    chrome.notifications.clear(notificationId);
  });
});

// ===== Tab 事件（保留原有 auth 逻辑） =====
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!authFlow || tabId !== authFlow.loginTabId) return;
  if (changeInfo.status === 'complete' || changeInfo.url) {
    completeAuthIfReady().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (!authFlow || tabId !== authFlow.loginTabId) return;
  authFlow = null;
  if (authCheckTimer) {
    clearInterval(authCheckTimer);
    authCheckTimer = null;
  }
});
