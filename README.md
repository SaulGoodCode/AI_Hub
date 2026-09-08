# AI Hub

> 聚合多个 AI 聊天站点的跨平台桌面客户端 —— 全局快捷键唤起、登录态持久化、单窗口多站点切换。

AI Hub 将 Claude、Gemini、DeepSeek、豆包等 AI 聊天服务整合到一个常驻系统的悬浮窗口中，通过 `WebContentsView` 内嵌第三方网页并持久化登录态，实现一键唤起、即开即用的 AI 对话体验。新站点默认共享会话，也可选择独立数据以登录其他账号。

支持 **Windows 11** 与 **macOS**。

## 特性

- **全局快捷键唤起** — 默认 `Ctrl+Shift+Space`，任意应用中一键呼出窗口；唤起后自动聚焦当前站点输入框，可直接打字
- **共享或独立数据** — 默认使用共享的 `persist:shared-sites` 会话；添加时勾选「使用独立数据」则按站点 ID 隔离。Cookie/IndexedDB 等持久化保存，编辑时也可切换模式
- **单窗口多站点** — 侧边栏一键切换；支持拖动排序、右键编辑/删除、自由添加任意 AI 网址
- **小窗转到浏览器** — 链接小窗标题栏右侧提供「在浏览器中打开」按钮，用系统默认浏览器打开小窗当前网址
- **按需加载省内存** — 切换站点自动销毁旧页面（登录态保留），重进自动恢复；记忆上次站点，启动直达
- **主题系统** — 亮色 / 暗色 / 跟随系统三档，通过 `nativeTheme` 同步进内置网页（支持深色的站点自动跟随）
- **Google 登录兼容** — 对齐真实 Chrome 指纹并关闭 passkey 弹窗，Gemini 可直接用 Google 账号密码登录
- **系统托盘常驻** — 关闭窗口即隐藏到托盘；托盘菜单支持置顶、唤起、退出
- **异常自动降级** — GPU 或沙箱异常时自动切换软件渲染重启（远程桌面 / 虚拟机友好）

![UI 预览](docs/demo/ui-screenshot.png)

## 快速开始

```bash
npm install        # 安装依赖
npm start          # 启动应用
npm run dev        # 开发模式（renderer 热刷新，main.js 自动重启）
```

> 国内网络建议配置 Electron 镜像：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

**开发热更新**：`npm run dev` 模式下，修改 `renderer/` 文件自动刷新页面；修改 `preload.js` 触发 reload；修改 `main.js` 自动重启主进程。

## 使用指南

| 操作 | 方式 |
|---|---|
| 唤起/隐藏窗口 | `Ctrl+Shift+Space`（可在设置中自定义） |
| 切换站点 | 点击侧边栏站点项（自动释放旧页面内存） |
| 拖动排序 | 展开侧边栏后，按住站点项上下拖动 |
| 添加站点 | 侧边栏底部「＋ 添加站点」 |
| 独立账号 | 添加时勾选「使用独立数据」；默认不勾选，使用共享会话 |
| 编辑/删除站点 | 右键站点项 → 编辑弹窗（改名 / 改网址 / 删除） |
| 在默认浏览器打开小窗页面 | 点击小窗标题右侧「在浏览器中打开 ↗」，打开当前网址（含跳转后的地址），小窗保留 |
| 删除本地数据 | 独立站点强制清空当前独立空间；共享站点可选清理对应网站专属的数据 |
| 主题切换 | 设置 → 外观主题 |
| 收起侧边栏 | 侧边栏头部 `«` 收起为图标列，`»` 展开 |

> 切换站点会销毁旧页面以节省内存，未发送的输入内容会丢失。

> 系统浏览器使用自己的登录状态；此按钮打开当前网页地址，不会复制 AI Hub 的 Cookie 或表单提交内容。

**数据模式与删除范围：**

- 共享模式类似同一个浏览器配置：同一网站的多个入口共享登录数据，跨网站登录页面也使用同一会话；不同网站仍遵循浏览器同源规则。
- 已有配置中的旧站点会保留独立模式和原登录态。要改为共享，右键编辑并取消「使用独立数据」。切换模式不会复制、合并或删除原分区的数据，可能需要重新登录；切回原模式可继续使用原数据。
- 独立站点删除时必须清理当前独立空间的数据和缓存，确认框中的清理项固定勾选、不可取消；重新添加会产生新 ID 和新的独立空间。
- 共享站点删除默认只移除入口，可选择清理网站专属数据。不勾选时保留数据，重启也不会自动清理，重新添加该网站后可继续使用。
- 勾选清理共享网站数据时，只清理配置网址的精确来源（协议、主机、端口）的本地存储、IndexedDB、Service Worker 和 Cache Storage，以及该主机专属的 Cookie。如果还有共享入口使用同一来源，则保留这份数据。
- 父域 Cookie、其他共享入口需要的 Cookie、第三方登录网站的数据和共享网络缓存会保留，避免连带影响其他网站。不会根据跳转或 OAuth 页面扩大清理范围。Electron 的批量 Cookie 清理会扩大到可注册域，因此这里采用逐项到期的方式处理专属 Cookie，详见 [Electron Session 文档](https://www.electronjs.org/docs/latest/api/session#sescleardataoptions)。

## 打包发布

### 本地打包

```bash
npm run dist:win     # Windows NSIS 安装包 → dist/AI-Hub-<版本>-x64.exe
npm run dist:mac     # macOS dmg + zip → dist/AI-Hub-<版本>-x64.dmg
npm run dist         # 当前平台打包
```

> **macOS 包需在 macOS 环境构建**：electron-builder 生成 dmg 依赖 macOS 系统工具链（`hdiutil`），无法在 Windows 上交叉构建。Windows 开发者可使用 GitHub Actions CI 完成 macOS 打包。

### GitHub Actions 自动发布

推送 `v*` 格式的 tag 即可触发 CI 双平台并行构建并发布到 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

CI 自动完成：
1. `macos-latest` 与 `windows-latest` 并行构建
2. 版本号与 tag 同步（`v1.0.0` → `package.json` 的 `1.0.0`）
3. 生成 Windows NSIS 安装包 + macOS dmg/zip
4. 自动创建 GitHub Release 并上传产物

> 默认不签名即可出包。如需正式代码签名，在仓库 Secrets 配置 `CSC_LINK` + `CSC_KEY_PASSWORD`，并移除 workflow 中的 `CSC_IDENTITY_AUTO_DISCOVERY: false`。

## 配置

配置文件位于用户数据目录下的 `config.json`：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\AI Hub\config.json` |
| macOS | `~/Library/Application Support/AI Hub/config.json` |

```json
{
  "shortcut": "Ctrl+Shift+Space",
  "alwaysOnTop": false,
  "sidebarCollapsed": false,
  "theme": "system",
  "sites": [
    { "id": "claude", "name": "Claude", "url": "https://claude.ai/chat/", "enabled": true, "useIndependentData": false }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `shortcut` | Electron accelerator 语法，如 `Alt+Space`、`CommandOrControl+Shift+A` |
| `theme` | `light` / `dark` / `system` |
| `sites` | 站点列表；共享数据存于 `Partitions/shared-sites`，独立数据存于 `Partitions/site-<id>` |
| `sites[].useIndependentData` | `false` 为共享，`true` 为独立；新增默认共享，旧配置缺少该字段时迁移为独立以保留登录态 |
| `builtinSeen` | 已下发过的内置站点 id；升级新增内置站点时按此增量补充，手动删掉的不会复活 |
| `pendingDataDeletions` | 明确要求清理的独立分区 ID；数据清空后，下次启动仅清理这份名单中的未使用目录 |

> 诊断日志位于 `userData/aihub.log`。共享站点不会加入整区目录清理名单。

## 技术架构

| 模块 | 职责 |
|---|---|
| `main.js` | 主进程：窗口管理、全局快捷键、托盘、`WebContentsView` 多标签、session 分区持久化、主题同步、输入框自动聚焦 |
| `site-data.js` | 数据模式迁移、共享/独立分区选择、按网站清理数据、独立分区目录清理名单 |
| `popup-window.js` / `popup-preload.js` / `renderer/popup.*` | 链接小窗和本地标题栏：显示网页标题、打开当前网址到默认浏览器、保留原网页的会话及 opener 通信 |
| `preload.js` | 通过 `contextBridge` 暴露安全 IPC 接口 |
| `site-preload.js` | 站点视图预加载：仅在 Google 域名下对齐 Chrome 指纹（`userAgentData` / `window.chrome` / 权限状态 / `languages`）并关闭 WebAuthn |
| `renderer/` | 渲染层 UI：侧边栏站点列表、自定义标题栏、弹窗交互、亮暗主题 |
| `scripts/launch.js` | 启动脚本：环境变量清理 + 开发模式文件监听热更新 |
| `scripts/sync-version.js` | CI 版本同步：将 git tag 写入 `package.json` |
| `.github/workflows/release.yml` | CI 流水线：tag 触发双平台构建并发布 |

**关键设计：**

- **登录态持久化** — 默认 `persist:shared-sites`，独立模式使用 `persist:site-<id>`；OAuth 弹窗与发起站点使用同一个 session
- **UA 清理** — 移除 User-Agent 中的 Electron 标识，并把 Chrome 版本降精度为 `major.0.0.0`（真实 Chrome 自 110 起的 UA reduction 格式；保留完整版本号反而是嵌入式浏览器的指纹）
- **Google 登录兼容** — Google 会把 Electron 判定为嵌入式浏览器并拦在 `/v3/signin/rejected`（"此浏览器或应用可能不安全"）。与同机真实 Chrome 逐项对比后，对齐了这些差异（全部只作用于 Google 域名）：`Sec-CH-UA` 请求头（Electron 根本不发）、品牌列表补 `Google Chrome`、UA 版本降精度、`window.chrome` 的 `app/csi/loadTimes`（Electron 是空对象，最扎眼的一项）、`Notification.permission` 与 `permissions.query`（Electron 一律答 `granted`，真实 Chrome 是 `default`/`prompt`）、`navigator.languages` 与 `Accept-Language`。实测：只改请求头仍被拦，页面侧补丁才是决定性的。另外摘掉 `PublicKeyCredential`，避免 passkey 条件式 UI 直接拉起 Windows 安全密钥对话框
- **唤起即聚焦** — 先将键盘焦点切到站点 webContents（`wc.focus()`），再聚焦输入框，解决多 webContents 下按键被侧边栏截获的问题
- **主题穿透** — `nativeTheme.themeSource` 驱动 `prefers-color-scheme`，内置站点深色模式自动跟随
- **隐藏即驻留** — 关闭拦截为隐藏，进程常驻托盘；单实例锁防止重复启动
- **自动降级** — GPU 或渲染进程异常时自动带 `--disable-gpu --no-sandbox` 重启一次
- **测试隔离** — DIAG 测试强制使用独立临时 userData 目录，绝不触碰真实登录态

## 开发调试

运行 `npm test` 执行真实 Electron Session 和界面/IPC 回归测试，覆盖共享复用、独立隔离、按网站清理、同源入口保护、Cookie 保护、旧配置迁移、启动清理及删除失败重试。测试使用独立临时目录和本地网页响应，不访问真实账号。

| 环境变量 | 作用 |
|---|---|
| `AIHUB_SCREENSHOT=1` | 窗口显示 4 秒后自动截图到 `userData/ui.png` |
| `AIHUB_DIAG=1` | 运行完整功能测试（强制隔离 userData，不可在真实数据上运行） |
| `AIHUB_TEST_DATA=1` | 强制使用独立临时 userData 目录 |

## 已知限制

- 第三方站点由系统 WebView 渲染，无法像浏览器扩展那样深度控制；个别站点对非标准浏览器设限时可能提示升级浏览器
- macOS dmg 打包依赖 macOS 系统工具链，无法在 Windows 上交叉构建（可通过 CI 的 `macos-latest` runner 解决）
- 切换站点会销毁旧页面以节省内存，未发送内容会丢失
- 独立站点删除时立即清空当前分区，残留目录在下次启动时按明确的清理名单删除；共享分区不会整区清空或删除

## 项目结构

```
ai-chat-hub/
├── main.js                # 主进程（含调试钩子）
├── site-data.js           # 会话选择、迁移与按网站清理数据
├── preload.js             # 预加载脚本
├── renderer/              # 渲染层 UI
│   ├── index.html
│   ├── style.css
│   └── app.js
├── scripts/
│   ├── launch.js          # 启动 + 开发热更新 + 测试隔离
│   └── sync-version.js    # CI 版本号同步
├── .github/workflows/     # GitHub Actions 自动发布
├── build/                 # 应用图标
├── docs/demo/             # 预览截图
└── package.json           # 依赖与打包配置
```

## License

MIT
