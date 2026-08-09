# MockLink — Axure 原型托管平台

MockLink 是一个 Axure 原型托管平台，支持登录注册、邮箱验证码、忘记密码、原型上传、分享、在线预览、分组管理和 Chrome 扩展一键同步。

项目支持两种运行方式：

- 本地开发：使用 `server/server.js` 启动 Node.js 服务。
- 云端部署：使用 Netlify Static + Netlify Functions + Netlify Blobs。

## 功能

| 功能 | 说明 |
|------|------|
| 登录注册 | 支持邮箱注册、验证码校验、登录会话 |
| 忘记密码 | 支持邮箱验证码重置密码 |
| 托管 | 上传 Axure 发布的整个目录，保持结构原样存储 |
| Chrome 扩展一键同步 | 在扩展弹窗里选择原型文件夹，一键上传并生成链接 |
| 分享 | 生成 `/s/{token}` 短链，发给任何人 |
| 在线查看 | 打开链接即可在浏览器查看可交互原型，点击列表行直接新标签页打开预览 |
| 原型管理 | 网页端管理所有原型：更新、分享、移动分组、清空 HTML、删除项目 |
| 新建项目 | 通过网页弹窗上传/更新原型，支持拖拽文件夹，可选择所属分组 |
| 分组管理 | 左侧分组栏，支持二级分组（创建、重命名、删除），按分组筛选原型 |
| Chrome 扩展下载 | 管理页面提供扩展打包下载入口 |

## 目录结构

```
axure-hosting-mvp/
├── netlify/
│   └── functions/
│       └── app.js       # Netlify Functions API
├── scripts/
│   └── build-netlify.mjs
├── server/              # 本地 Node.js 服务
│   ├── server.js        # 本地 API + 静态分发
│   ├── public/
│   │   ├── index.html
│   │   ├── login.html
│   │   └── logo.png
│   └── storage/         # 本地运行后自动生成，不提交到 Git
├── extension/           # Chrome 扩展（MockLink 一键同步）
├── netlify.toml         # Netlify 构建、函数和路由配置
├── package.json
└── package-lock.json
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动本地服务

```bash
node server/server.js
```

启动后访问 http://localhost:3000 即看到原型管理页面。

默认管理员账号：

```text
账号：admin
密码：666666
```

## Netlify 部署

推荐通过 Git 仓库部署，拖拽部署无法部署 Netlify Functions，因此登录、注册、忘记密码、上传、分享等动态功能不可用。

### 构建配置

Netlify 导入 Git 仓库后使用以下配置：

| 配置项 | 值 |
|---|---|
| Build command | `npm run build` |
| Publish directory | `server/public` |
| Functions directory | `netlify/functions` |

项目根目录已经包含 `netlify.toml`，Netlify 会自动读取函数目录和路由配置。

### 环境变量

如果需要真实发送注册和忘记密码验证码，请在 Netlify 站点后台配置：

```bash
RESEND_API_KEY=你的 Resend API Key
RESEND_FROM=MockLink <你的发信邮箱>
```

未配置邮件变量时，接口会返回测试验证码，便于开发测试。

## 使用说明

### 网页管理

1. 打开 http://localhost:3000
2. 登录账号
3. 点击「新建项目」按钮，在弹窗中选择分组并上传 Axure 发布的文件夹
4. 上传完成后自动生成分享链接
5. 点击列表行可直接在新标签页打开原型预览
6. 每个原型支持更新、分享、移动分组、清空 HTML 和删除

### 分组管理

1. 点击左侧分组栏顶部的「+」按钮创建分组
2. 支持二级分组：创建时可选择父分组
3. 点击分组名称可按分组筛选原型
4. 悬浮分组行显示编辑/删除按钮
5. 删除分组时，子分组一并删除，分组下的原型变为未分组

### Chrome 扩展一键同步

1. 在管理页面点击右上角「Chrome 扩展」按钮下载扩展 zip
2. 解压后，打开 Chrome → `chrome://extensions`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选中解压后的 `extension/` 文件夹
5. 点击工具栏扩展图标，确认服务器地址为 `http://localhost:3000`
6. 点击「选择 Axure 原型文件夹」，选中 Axure 发布的目录
7. 上传完成后链接自动复制到剪贴板

> 真实使用时，在 Axure RP 中「发布 → 本地」生成目录，再用扩展上传该目录。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/prototypes` | 列出所有原型（含名称、状态、大小、时间、分组） |
| POST | `/api/prototypes` | 创建原型，返回 token（可携带 groupId） |
| POST | `/api/prototypes/:token/files` | 上传单个文件（JSON: `{ path, content: base64 }`） |
| POST | `/api/prototypes/:token/update` | 更新原型（清空旧文件，token 和分享链接不变） |
| POST | `/api/prototypes/:token/clear` | 清空 HTML 文件（保留项目记录） |
| POST | `/api/prototypes/:token/publish` | 发布，返回分享链接 |
| GET | `/api/prototypes/:token` | 查询元数据 |
| PUT | `/api/prototypes/:token` | 更新原型元数据（如移动分组） |
| DELETE | `/api/prototypes/:token` | 删除原型（永久删除所有文件） |
| GET | `/api/groups` | 列出所有分组 |
| POST | `/api/groups` | 创建分组（可携带 parentId 实现二级分组） |
| PUT | `/api/groups/:id` | 更新分组（重命名 / 移动） |
| DELETE | `/api/groups/:id` | 删除分组（含子分组，原型变为未分组） |
| GET | `/api/extension/download` | 下载 Chrome 扩展 zip |
| GET | `/s/:token` | 分享链接（302 重定向到查看页） |
| GET | `/v/:token/*` | 在线查看（分发原型静态文件） |

### 更新流程

更新操作会清空原有文件并重新上传，但 token 和分享链接保持不变：

1. `POST /api/prototypes/:token/update` — 清空旧文件，可携带新名称
2. `POST /api/prototypes/:token/files` — 上传新文件（可多次调用）
3. `POST /api/prototypes/:token/publish` — 重新发布

网页端在原型列表中每条记录右侧有操作按钮，点击「更新」后选择新文件夹即可。
Chrome 扩展在分隔线下方输入 token 或粘贴分享链接，再选择文件即可更新。

## Netlify 部署

当前项目已支持 Netlify Functions + Netlify Blobs 部署：

1. 将项目根目录连接到 Netlify。
2. 构建命令使用 `npm run build`。
3. 发布目录使用 `server/public`。
4. Functions 目录使用 `netlify/functions`。
5. 部署后访问站点首页，默认管理员账号为 `admin`，密码为 `666666`。

部署后的数据不再写入 `server/storage`，而是写入 Netlify Blobs：

- `system/users.json`：用户与管理员账号。
- `system/sessions.json`：登录会话。
- `system/groups.json`：分组。
- `prototypes/index.json`：原型 token 索引。
- `prototypes/{token}/meta.json`：原型元数据。
- `prototypes/{token}/files/*`：原型文件二进制内容。

## 后续扩展

当前为第一阶段实现。后续可叠加：
- 登录与配额管理
- 版本管理与回溯
- 预签名直传对象存储（替换本地磁盘）
- 私有化部署（Docker Compose + MinIO）
- 深度搜索（解析 document.js 建立索引）
