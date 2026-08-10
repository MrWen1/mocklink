// MockLink Chrome 扩展 - 内容脚本
// 检测 Axure 原型页面，全面收集所有资源文件路径

const MOCKLINK_COLLECTOR_VERSION = '2.3.1';

// ===== 检测当前页面是否为 Axure 原型 =====
function detectAxure() {
  if (typeof window.$axure !== 'undefined') return true;
  if (document.querySelector('#base')) return true;
  const scripts = Array.from(document.querySelectorAll('script[src]'));
  if (scripts.some(s =>
    s.src.includes('resources/scripts/axure') ||
    s.src.includes('resources/scripts/prototype') ||
    s.src.includes('/data/document.js')
  )) return true;
  const meta = document.querySelector('meta[name="generator"]');
  if (meta && meta.content && meta.content.toLowerCase().includes('axure')) return true;
  if (document.querySelector('.ax_default, .ax_default_sketch, [class*="axure"]')) return true;
  const html = document.documentElement.innerHTML;
  if (html.includes('$axure.loadDocument') || html.includes('axurePlayer')) return true;
  const pageName = window.location.pathname.split('/').pop() || '';
  if ((pageName === 'start.html' || pageName === 'index.html') &&
      (document.querySelector('#base') || document.querySelector('#mainPanel'))) return true;
  return false;
}

// ===== 获取原型基础 URL（目录路径）=====
function getBaseUrl() {
  const url = window.location.href;
  const lastSlash = url.lastIndexOf('/');
  return url.substring(0, lastSlash + 1);
}

function getCurrentFilePath(baseUrl) {
  const raw = window.location.href.replace(baseUrl, '').split('?')[0].split('#')[0] || 'index.html';
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

// ===== 获取原型名称 =====
function getPrototypeName() {
  const previewInfo = window.PREVIEW_INFO || {};
  const fileName = previewInfo.fileName || previewInfo.filename || '';
  if (fileName) {
    try {
      const decoded = decodeURIComponent(String(fileName).replace(/\+/g, ' ')).trim();
      if (decoded) return decoded;
    } catch (e) {
      const raw = String(fileName).trim();
      if (raw) return raw;
    }
  }
  const url = window.location.href;
  const parts = url.replace(/\/$/, '').split('/');
  const dirName = parts[parts.length - 2] || parts[parts.length - 1] || '未命名原型';
  return decodeURIComponent(dirName.split('?')[0]);
}

// ===== 将绝对 URL 转为相对路径 =====
function toRelativePath(absoluteUrl, baseUrl) {
  try {
    if (absoluteUrl.startsWith(baseUrl)) {
      const rel = absoluteUrl.substring(baseUrl.length).split('?')[0].split('#')[0];
      try { return decodeURIComponent(rel); } catch (e) { return rel; }
    }
    const u = new URL(absoluteUrl);
    const base = new URL(baseUrl);
    if (u.origin === base.origin) {
      let rel = u.pathname + u.search;
      if (rel.startsWith(base.pathname)) {
        rel = rel.substring(base.pathname.length);
      } else {
        // Different path but same origin - try to make relative
        const baseParts = base.pathname.split('/').filter(Boolean);
        const urlParts = u.pathname.split('/').filter(Boolean);
        // Find common prefix
        let i = 0;
        while (i < baseParts.length && i < urlParts.length && baseParts[i] === urlParts[i]) i++;
        // Build relative path
        const upCount = baseParts.length - i;
        const remaining = urlParts.slice(i);
        rel = '../'.repeat(upCount) + remaining.join('/');
      }
      rel = rel.split('?')[0].split('#')[0];
      try { return decodeURIComponent(rel); } catch (e) { return rel; }
    }
  } catch (e) {}
  return null;
}

function resolveResourceUrl(relPath, baseUrl) {
  try {
    return new URL(String(relPath).split('#')[0], baseUrl).href;
  } catch (e) {
    return baseUrl + String(relPath).replace(/^\/+/, '');
  }
}

function addResource(resources, resourceUrls, relPath, baseUrl, sourceUrl) {
  if (!relPath) return;
  const clean = normalizePath(String(relPath).split('?')[0].split('#')[0]);
  if (!isValidPath(clean)) return;
  resources.add(clean);
  if (!resourceUrls.has(clean)) {
    resourceUrls.set(clean, sourceUrl || resolveResourceUrl(clean, baseUrl));
  }
}

// ===== 规范化路径（处理 ./ 和 ../）=====
function normalizePath(p) {
  if (!p) return '';
  const parts = p.split('/');
  const result = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (result.length > 0) result.pop();
      continue;
    }
    result.push(part);
  }
  return result.join('/');
}

// ===== 检查路径是否有效 =====
function isValidPath(path) {
  if (!path || path.length === 0) return false;
  if (path.startsWith('chrome-extension://') ||
      path.startsWith('data:') ||
      path.startsWith('blob:') ||
      path.startsWith('http://') ||
      path.startsWith('https://') ||
      path.startsWith('chrome://') ||
      path.startsWith('about:') ||
      path === 'undefined' ||
      path === 'null') return false;
  // 必须包含至少一个点（文件扩展名）或斜杠（目录路径）
  if (!path.includes('.') && !path.includes('/')) return false;
  // 过滤掉看起来像 JavaScript 变量名的路径
  if (!path.includes('/') && !path.includes('.')) return false;
  // 过滤掉以特殊字符开头的路径
  if (path.startsWith('@') || path.startsWith('#')) return false;
  return true;
}

// ===== 解析 CSS url() 引用 =====
function extractCssUrls(cssText, cssFilePath, resources, cssFilesToParse, baseUrl) {
  // url() 引用
  const urlMatches = cssText.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
  for (const match of urlMatches) {
    const urlRef = match[1].trim();
    if (!urlRef || urlRef.startsWith('data:') || urlRef.startsWith('blob:') || urlRef.startsWith('http')) continue;
    // 解析相对于 CSS 文件位置的路径
    const cssDir = cssFilePath.includes('/') ? cssFilePath.substring(0, cssFilePath.lastIndexOf('/') + 1) : '';
    const resolved = normalizePath(cssDir + urlRef);
    if (resolved && isValidPath(resolved)) {
      addResource(resources, window.__axureResourceUrls, resolved, baseUrl);
      if (resolved.endsWith('.css')) cssFilesToParse.add(resolved);
    }
  }
  // @import 引用
  const importMatches = cssText.matchAll(/@import\s+['"]([^'"]+)['"]/g);
  for (const match of importMatches) {
    const importRef = match[1].trim();
    if (!importRef || importRef.startsWith('http')) continue;
    const cssDir = cssFilePath.includes('/') ? cssFilePath.substring(0, cssFilePath.lastIndexOf('/') + 1) : '';
    const resolved = normalizePath(cssDir + importRef);
    if (resolved && isValidPath(resolved)) {
      addResource(resources, window.__axureResourceUrls, resolved, baseUrl);
      cssFilesToParse.add(resolved);
    }
  }
}

function addAxurePageSupportFiles(pagePath, resources, cssFilesToParse, baseUrl) {
  if (!pagePath || !/\.html?$/i.test(pagePath)) return;
  const clean = normalizePath(String(pagePath).split('?')[0].split('#')[0]);
  if (!clean || /^(?:index|start|start_with_pages|start_c_\d*)\.html?$/i.test(clean)) return;
  const stem = clean.replace(/\.html?$/i, '');
  const dataPath = normalizePath(`files/${stem}/data.js`);
  const stylePath = normalizePath(`files/${stem}/styles.css`);
  addResource(resources, window.__axureResourceUrls, dataPath, baseUrl);
  addResource(resources, window.__axureResourceUrls, stylePath, baseUrl);
  cssFilesToParse.add(stylePath);
}

// ===== 解析 HTML 页面中的资源引用 =====
function extractHtmlResources(doc, pagePath, resources, cssFilesToParse, htmlPagesToParse, baseUrl) {
  const pageDir = pagePath.includes('/') ? pagePath.substring(0, pagePath.lastIndexOf('/') + 1) : '';

  // script, link, img, source, video, audio, iframe
  doc.querySelectorAll('script[src], link[href], img[src], source[src], video[src], audio[src], iframe[src]').forEach(el => {
    const src = el.getAttribute('src') || el.getAttribute('href');
    if (!src || src.startsWith('chrome-extension://') || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) return;
    try {
      const resolved = normalizePath(pageDir + src);
      if (resolved && isValidPath(resolved)) {
        resources.add(resolved);
        addResource(resources, window.__axureResourceUrls, resolved, baseUrl);
        if (resolved.endsWith('.css')) cssFilesToParse.add(resolved);
        if (resolved.endsWith('.html')) {
          htmlPagesToParse.add(resolved);
          addAxurePageSupportFiles(resolved, resources, cssFilesToParse, baseUrl);
        }
      }
    } catch (e) {}
  });

  // a[href] 链接
  doc.querySelectorAll('a[href]').forEach(el => {
    const href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:')) return;
    if (href.endsWith('.html')) {
      const resolved = normalizePath(pageDir + href);
      if (resolved && isValidPath(resolved)) {
        addResource(resources, window.__axureResourceUrls, resolved, baseUrl);
        htmlPagesToParse.add(resolved);
        addAxurePageSupportFiles(resolved, resources, cssFilesToParse, baseUrl);
      }
    }
  });

  // 内联 CSS url()
  doc.querySelectorAll('style').forEach(styleEl => {
    const text = styleEl.textContent || '';
    extractCssUrls(text, pagePath, resources, cssFilesToParse, baseUrl);
  });

  // 内联 style 属性中的 url()
  doc.querySelectorAll('[style]').forEach(el => {
    const style = el.getAttribute('style') || '';
    if (style.includes('url(')) {
      extractCssUrls(style, pagePath, resources, cssFilesToParse, baseUrl);
    }
  });
}

// ===== 收集所有资源文件路径 =====
async function collectAllResources() {
  const resources = new Set();
  const resourceUrls = new Map();
  window.__axureResourceUrls = resourceUrls;
  const baseUrl = getBaseUrl();
  const cssFilesToParse = new Set();
  const htmlPagesToParse = new Set();
  const parsedHtmlPages = new Set();
  const parsedCssFiles = new Set();

  // 1. 添加当前页面
  const currentFile = getCurrentFilePath(baseUrl);
  addResource(resources, resourceUrls, currentFile, baseUrl, window.location.href);
  if (currentFile.endsWith('.html')) {
    htmlPagesToParse.add(currentFile);
    addAxurePageSupportFiles(currentFile, resources, cssFilesToParse, baseUrl);
  }

  // Axure 必需数据文件。若读取失败，上传阶段会明确报出关键文件缺失，避免发布空白页。
  addResource(resources, resourceUrls, 'data/document.js', baseUrl);
  addResource(resources, resourceUrls, 'data/styles.css', baseUrl);
  cssFilesToParse.add('data/styles.css');

  // 2. Performance API — 所有已加载的资源
  performance.getEntriesByType('resource').forEach(entry => {
    const rel = toRelativePath(entry.name, baseUrl);
    if (rel && isValidPath(rel)) {
      const cleanPath = rel.split('?')[0].split('#')[0];
      if (isValidPath(cleanPath)) {
        addResource(resources, resourceUrls, cleanPath, baseUrl, entry.name);
        if (cleanPath.endsWith('.css')) cssFilesToParse.add(cleanPath);
        if (cleanPath.endsWith('.html')) htmlPagesToParse.add(cleanPath);
      }
    }
  });

  // 3. DOM 引用的资源
  extractHtmlResources(document, currentFile, resources, cssFilesToParse, htmlPagesToParse, baseUrl);

  // 4. document.styleSheets 中的 url() 引用
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.style) {
          const bg = rule.style.backgroundImage || rule.style.content || rule.style.listStyleImage || '';
          if (bg && bg.includes('url(')) {
            // 找到 CSS 文件路径
            let cssPath = '';
            try {
              if (sheet.href) {
                cssPath = toRelativePath(sheet.href, baseUrl) || '';
              }
            } catch (e) {}
            extractCssUrls(bg, cssPath || currentFile, resources, cssFilesToParse, baseUrl);
          }
        }
      }
    } catch (e) {} // 跨域 CSS
  }

  // 5. 获取并解析 data/document.js — 提取页面 URL 和资源路径
  try {
    const docJsRes = await fetch(baseUrl + 'data/document.js');
    if (docJsRes.ok) {
      addResource(resources, resourceUrls, 'data/document.js', baseUrl);
      const jsText = await docJsRes.text();
      // 提取所有 .html 文件路径 (Axure 页面)
      const htmlMatches = jsText.matchAll(/["']([^"'\s]*\.html)["']/g);
      for (const match of htmlMatches) {
        const path = match[1];
        if (path && !path.startsWith('http') && isValidPath(path)) {
          addResource(resources, resourceUrls, path, baseUrl);
          htmlPagesToParse.add(path);
          addAxurePageSupportFiles(path, resources, cssFilesToParse, baseUrl);
        }
      }
      // 提取所有 .js 文件路径
      const jsMatches = jsText.matchAll(/["']([^"'\s]*\.js)["']/g);
      for (const match of jsMatches) {
        const path = match[1];
        if (path && !path.startsWith('http') && !path.startsWith('resources/scripts/jquery') && isValidPath(path)) {
          addResource(resources, resourceUrls, path, baseUrl);
        }
      }
      // 提取所有 .css 文件路径
      const cssMatches = jsText.matchAll(/["']([^"'\s]*\.css)["']/g);
      for (const match of cssMatches) {
        const path = match[1];
        if (path && !path.startsWith('http') && isValidPath(path)) {
          addResource(resources, resourceUrls, path, baseUrl);
          cssFilesToParse.add(path);
        }
      }
    }
  } catch (e) {}

  // 6. 尝试获取并解析 index.html
  for (const pageName of ['index.html', 'start.html', 'start_with_pages.html', 'start_c_1.html']) {
    if (parsedHtmlPages.has(pageName)) continue;
    parsedHtmlPages.add(pageName);
    try {
      const res = await fetch(baseUrl + pageName);
      if (!res.ok) continue;
      addResource(resources, resourceUrls, pageName, baseUrl);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      extractHtmlResources(doc, pageName, resources, cssFilesToParse, htmlPagesToParse, baseUrl);
    } catch (e) {}
  }

  // 7. 递归获取并解析每个 HTML 页面
  let iterations = 0;
  while (htmlPagesToParse.size > 0 && iterations < 100) {
    iterations++;
    const page = htmlPagesToParse.values().next().value;
    htmlPagesToParse.delete(page);
    if (parsedHtmlPages.has(page)) continue;
    parsedHtmlPages.add(page);
    try {
      const res = await fetch(baseUrl + page);
      if (!res.ok) continue;
      addResource(resources, resourceUrls, page, baseUrl);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      extractHtmlResources(doc, page, resources, cssFilesToParse, htmlPagesToParse, baseUrl);
    } catch (e) {}
  }

  // 8. 递归获取并解析每个 CSS 文件
  iterations = 0;
  while (cssFilesToParse.size > 0 && iterations < 100) {
    iterations++;
    const cssFile = cssFilesToParse.values().next().value;
    cssFilesToParse.delete(cssFile);
    if (parsedCssFiles.has(cssFile)) continue;
    parsedCssFiles.add(cssFile);
    try {
      const res = await fetch(baseUrl + cssFile);
      if (!res.ok) continue;
      addResource(resources, resourceUrls, cssFile, baseUrl);
      const cssText = await res.text();
      extractCssUrls(cssText, cssFile, resources, cssFilesToParse, baseUrl);
    } catch (e) {}
  }

  // 9. 添加 Axure 常见资源路径（如果存在）
  const commonPaths = [
    'resources/css/reset.css',
    'resources/css/default.css',
    'resources/css/axure_rp_page.css',
    'resources/css/jquery-ui-themes.css',
    'resources/css/previewfonts.css',
    'resources/scripts/jquery-3.7.1.min.js',
    'resources/scripts/axutils.js',
    'resources/scripts/messagecenter.js',
    'resources/scripts/hintmanager.js',
    'resources/scripts/player/init.js',
    'resources/scripts/player/splitter.js',
    'resources/scripts/player/axplayer.js',
    'resources/Other.html',
    'resources/reload.html',
    'data/styles.css',
    'data/document.js',
  ];
  // Axure 核心脚本
  const axureScripts = [
    'axQuery', 'axQuery.std', 'globals', 'annotation', 'doc', 'events', 'action',
    'expr', 'geometry', 'flyout', 'model', 'repeater', 'sto', 'utils.temp',
    'variables', 'drag', 'move', 'visibility', 'style', 'adaptive', 'tree',
    'init.temp', 'legacy', 'viewer', 'math', 'ios', 'ie', 'recording',
    'jquery.nicescroll.min'
  ];
  for (const script of axureScripts) {
    commonPaths.push('resources/scripts/axure/' + script + '.js');
  }
  // 常见插件
  const plugins = [
    'plugins/sitemap/sitemap.js', 'plugins/sitemap/styles/sitemap.css',
    'plugins/page_notes/page_notes.js', 'plugins/page_notes/styles/page_notes.css',
    'plugins/debug/debug.js', 'plugins/debug/styles/debug.css',
    'plugins/recordplay/recordplay.js', 'plugins/recordplay/styles/recordplay.css',
  ];
  commonPaths.push(...plugins);

  // 验证这些路径是否存在（HEAD 请求）
  for (const p of commonPaths) {
    if (!resources.has(p)) {
      try {
        const res = await fetch(resolveResourceUrl(p, baseUrl));
        if (res.ok) addResource(resources, resourceUrls, p, baseUrl);
      } catch (e) {}
    }
  }

  // 10. 过滤并返回
  const validResources = Array.from(resources).filter(isValidPath).sort();
  return validResources.map(path => ({
    path,
    url: resourceUrls.get(path) || resolveResourceUrl(path, baseUrl)
  }));
}

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_AXURE') {
    const isAxure = detectAxure();
    const name = isAxure ? getPrototypeName() : null;
    const baseUrl = isAxure ? getBaseUrl() : null;
    const url = window.location.href;
    sendResponse({ isAxure, name, baseUrl, url, collectorVersion: MOCKLINK_COLLECTOR_VERSION });
    return true;
  }

  if (message.type === 'COLLECT_RESOURCES') {
    collectAllResources().then(resources => {
      const baseUrl = getBaseUrl();
      const name = getPrototypeName();
      const entryPath = getCurrentFilePath(baseUrl);
      sendResponse({ success: true, baseUrl, resources, name, entryPath, collectorVersion: MOCKLINK_COLLECTOR_VERSION });
    }).catch(error => {
      sendResponse({ success: false, error: error.message, collectorVersion: MOCKLINK_COLLECTOR_VERSION });
    });
    return true;
  }
});
