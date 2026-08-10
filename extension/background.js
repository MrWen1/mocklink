const MOCKLINK_SERVER = 'https://mocklink.netlify.app';

let authFlow = null;
let authCheckTimer = null;

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
});

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
