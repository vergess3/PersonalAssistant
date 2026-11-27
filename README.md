# PersonalAssistant (`hilly-weixin-slack-bridge`)

一个运行在 Windows 本机、**纯出站（Outbound-Only）**的 **微信（iLink Bot 协议）↔ Slack 私聊助手（Slack MCP + Web API）** 双向消息桥接工具。

无需公网 IP、Webhook、内网穿透或额外大模型 API Key，直接将你绑定的一对一微信机器人会话与现有 Slack DM 助手（如 Hilly）打通。

---

## 为什么采用“微信 ↔ Slack”桥接，而不是直接给 ChatGPT 接自定义 MCP？

在方案选型上，本项目**刻意没有**采用“把微信/本地能力封装成自定义 MCP Server 供 ChatGPT 直接调用”的做法，核心原因如下：

1. **避免触发 ChatGPT 侧的高频 MCP 风控**
   - 如果由 ChatGPT 直接频繁调用自定义 MCP（例如持续轮询、收发外部消息或读写本地资源），ChatGPT 平台侧能够识别到异常偏高的 MCP 调用频次与自动化特征，存在触发风控甚至封号的风险（此前社区已有用户通过 ChatGPT 调用自定义 MCP 浏览本地文件而被封禁的先例）。
2. **走 ChatGPT 官方原生允许的 Slack 通道**
   - Slack 本身是 ChatGPT / 个人助手（如 Hilly）官方支持并允许的对话入口。通过本机桥接把微信消息中转到既有的 Slack 私聊中，助手侧看到的只是正常的 Slack DM 对话，不需要在 ChatGPT 侧挂载自定义 MCP，也不产生高频的 ChatGPT 自定义 MCP 调用记录。
3. **关于代码中 `slack-mcp` 的说明（注意区分方向）**
   - 本项目里用到的 `https://mcp.slack.com/mcp` 是 **Slack 官方提供的 MCP 端点**，仅由本机桥接进程主动调用，用来向你自己的 Slack DM 发送消息和上传文件；**并不是**把本机/微信暴露为给 ChatGPT 调用的自定义 MCP Server。

---

## 核心特性

- **双向原生转发**
  - **微信 → Slack**：将绑定微信用户的文字、图片、视频、文档、语音转发到指定的 Slack DM（通过 Slack MCP Server `https://mcp.slack.com/mcp` 发送消息与上传文件）。
  - **Slack → 微信**：轮询监听指定 DM 中助手的新回复、文件附件与 Emoji Reaction，即时回传到微信。
- **话题线程与微信原生引用（Quote）**
  - 保留微信原生引用消息，自动映射回对应的 Slack Thread 追问。
  - 多话题穿插回复时，仅在切换话题时自动附加微信 `ref_msg` 原生引用，避免同一话题连续消息重复刷屏。
- **附件暂存与语音本地转码**
  - 微信每条消息仅携带单个附件，纯图片/文件/视频消息会自动暂存，等待随后的文字或语音指令（或与 15 秒内的前序文字配对）一并发送到同一 Slack 话题。
  - 语音消息按真实二进制容器头识别，内置 `silk-wasm` 在内存中将腾讯微信 SILK（含 `encode_type=4` 标记）本地解码为 **单声道 24 kHz 16-bit PCM WAV** 再上传 Slack，同时保留语音转文字内容。
- **Slack 富文本渲染与 Reaction 反馈**
  - 自动将 Slack Block Kit / mrkdwn 转为易读的微信纯文本，保留段落、列表，并将带标签的链接整理为文末编号参考。
  - 助手对消息点 👍（`+1` / `thumbsup`）转发为 `👍`；其他处理中表情（如 👀）转发为一次 `稍等` 提示。
- **安全与持久化队列**
  - 所有凭据（`state/credentials.dpapi`）、消息队列与引用索引（`state/relay-queue.dpapi`）和诊断日志均使用 **Windows DPAPI (`CurrentUser`)** 加密落盘，不写入明文配置或控制台日志。
  - 支持单实例进程锁（`state/bridge.lock`）、优雅停机标志（`state/relay.stop`）与断点续传，防止重启重放历史消息。
- **物理网卡直连（Physical Direct）**
  - 支持通过 Python 子进程将发往 `*.slack.com` 和 `*.qq.com` 的 HTTPS 请求绑定到指定物理网卡、本机 IPv4 和自定义 DNS，规避本机代理/TUN 路由干扰。

---

## 目录结构

```text
PersonalAssistant/
├── .gitignore
├── README.md
└── bridge/
    ├── package.json                # Node.js 依赖与脚本入口
    ├── relay-runtime.json          # 运行时策略与网络模式配置
    ├── slack-app-manifest.json     # Slack App Manifest 模板
    ├── .env.example                # 环境变量参考
    ├── src/
    │   ├── config.mjs              # 目标 Slack Workspace / User / DM / Assistant ID 配置
    │   ├── setup.mjs               # 本机 127.0.0.1:37641 授权配置 Web UI
    │   ├── setup-slack.mjs         # Slack User Token 权限校验与加密保存
    │   ├── connector-main.mjs      # 主程序 CLI 入口（status / check / receive / forward）
    │   ├── connector.mjs           # Slack MCP Server 客户端（发消息 / 两步法文件上传）
    │   ├── managed-connector.mjs   # MCP 连接托管与重连管理
    │   ├── clients.mjs             # Slack Web API 与微信 iLink Bot API 客户端
    │   ├── relay.mjs               # 双向队列状态机、附件暂存、引用映射、Reaction 处理
    │   ├── relay-loop.mjs          # 微信长轮询与 Slack 活跃/历史话题轮询调度
    │   ├── runner.mjs              # 主运行循环与健康状态上报
    │   ├── vault.mjs               # Windows DPAPI 加密存储与进程锁
    │   ├── voice-audio.mjs         # 微信 SILK 语音本地转 WAV
    │   ├── weixin-media.mjs        # 微信加密 CDN 媒体加解密与上传下载
    │   ├── slack-text.mjs          # Slack Block Kit / mrkdwn 转微信纯文本
    │   ├── network.mjs             # HTTP 分发器（physical-direct / 默认 undici）
    │   ├── direct-http.mjs         # 物理网卡直连 Node 侧桥接
    │   └── direct-http.py          # 物理网卡直连 Python Worker
    ├── scripts/
    │   ├── run-relay.ps1           # Windows 常驻守护启动脚本（适合计划任务）
    │   ├── render-qr.py            # 微信登录二维码渲染脚本（SVG + PNG）
    │   ├── mcp-preflight.mjs       # 只读权限与 MCP 工具预检
    │   ├── inspect-network-route.mjs
    │   ├── probe-physical-egress.py
    │   └── ...                     # 其他网络排查与运维脚本
    └── test/                       # Node 内置测试套件（111 个离线单元测试）
```

> 运行态目录 `bridge/state/`（含 `credentials.dpapi`、`relay-queue.dpapi`、`health.json`、`bridge.lock`）与 `bridge/*.log` 已被 `.gitignore` 忽略，不会被提交到 Git。

---

## 环境要求

1. **操作系统**：**Windows**（强依赖 Windows DPAPI `System.Security.Cryptography.ProtectedData` 以及 PowerShell 守护脚本）。
2. **Node.js**：`>= 22.19.0`（含 `npm`）。
3. **Python 3**：
   - 运行 `physical-direct` 物理网卡直连 Worker（`src/direct-http.py`，仅用标准库）。
   - 运行扫码授权页生成二维码（`scripts/render-qr.py`，需安装 `reportlab` 和 `Pillow`）。

---

## 快速 Setup 指南

### 第 1 步：克隆仓库并安装依赖

```powershell
git clone https://github.com/vergess3/PersonalAssistant.git
cd PersonalAssistant\bridge

# 安装 Node.js 依赖（silk-wasm、undici）
npm install

# 安装二维码生成所需的 Python 依赖（仅授权配置阶段需要）
pip install reportlab pillow
```

先跑一遍离线测试确认基础环境正常：

```powershell
npm test
```

---

### 第 2 步：配置目标 Slack 实体 ID

编辑 [`bridge/src/config.mjs`](bridge/src/config.mjs)，将以下 4 个 ID 替换为**你自己的 Slack 环境**：

```js
export const target = {
  slackTeam: 'TXXXXXXXXXX',          // Slack Workspace (Team) ID
  slackUser: 'UXXXXXXXXXX',          // 你自己的 Slack User ID（发送人）
  slackChannel: 'DXXXXXXXXXX',       // 你与 Slack 助手的 DM 频道 ID
  slackAssistantUser: 'UYYYYYYYYYY', // Slack 助手的 User ID
};
```

> **提示**：如果你需要使用 `npm run relay:check` 或 `node scripts/mcp-preflight.mjs` 做只读连通性校验，请同步检查 [`bridge/src/connector.mjs`](bridge/src/connector.mjs) 中 `verifyRead()` 方法里的验证线程时间戳与关键字，将其改为你自己 DM 中一条已存在的历史对话线程（你发问 + 助手已回复）。

---

### 第 3 步：配置网络与运行时参数

编辑 [`bridge/relay-runtime.json`](bridge/relay-runtime.json)：

```json
{
  "receiveLoopEnabled": true,
  "forwardingEnabled": true,
  "transport": "slack-mcp",
  "network": {
    "mode": "physical-direct",
    "interfaceIndex": 18,
    "localAddress": "10.1.0.15",
    "dnsServers": [
      "183.60.83.19",
      "183.60.82.98"
    ],
    "pythonPath": "C:/Path/To/python.exe"
  }
}
```

如何获取本机物理网卡参数（PowerShell）：

```powershell
Get-NetIPConfiguration
```

从中找到你实际联网的物理网卡的 `InterfaceIndex`、`IPv4Address` 与 `DNSServer`，填入 `relay-runtime.json`，并将 `pythonPath` 改为你本机的 `python.exe` 完整路径。

> **注意**：[`bridge/src/setup.mjs`](bridge/src/setup.mjs) 中调用 `scripts/render-qr.py` 处也有一处 `python.exe` 路径，如与你本机路径不一致，请一并修改后再启动配置页。

---

### 第 4 步：创建并配置 Slack App

1. 打开 [Slack API Apps 控制台](https://api.slack.com/apps)，点击 **Create New App → From a manifest**。
2. 选择你的目标 Workspace，粘贴 [`bridge/slack-app-manifest.json`](bridge/slack-app-manifest.json) 的内容创建应用。
3. 在应用设置中开启 **Slack MCP Server** 功能。
4. 进入 **OAuth & Permissions → User Token Scopes**（注意是 **User Token Scopes**，**不要**添加到 Bot Token Scopes），确认包含以下 4 个最小权限：
   - `chat:write`
   - `im:history`
   - `files:read`
   - `files:write`
5. 点击 **Install to Workspace**（如果后续补充了权限，务必点击 **Reinstall to Workspace** 重新授权），复制生成的 **User OAuth Token**（以 `xoxp-` 开头）。

---

### 第 5 步：通过本机安全页完成 Slack 与微信绑定

在 `bridge/` 目录下启动本机授权页面（仅监听 `127.0.0.1:37641`，带 CSRF Token 与 CSP 保护）：

```powershell
cd bridge
node src/setup.mjs
```

浏览器打开 `http://127.0.0.1:37641`：

1. **Slack 用户授权**：
   - 将第 4 步复制的 `xoxp-...` User OAuth Token 粘贴到输入框，点击 **验证并加密保存**。
   - 程序会调用 `slack.com/api/auth.test` 校验 Token 所属 Team/User 是否与 `src/config.mjs` 一致，并核验 4 个必要 Scope，通过后以 Windows DPAPI 加密写入 `bridge/state/credentials.dpapi`。
2. **微信扫码绑定**：
   - 点击 **生成微信授权二维码**，用你自己的微信扫描并确认授权（如手机提示输入配对码，在页面本机输入框提交即可）。
   - 绑定成功后，微信 `bot_token`、`botId`、`userId` 与 `origin` 会加密保存到同一份 `bridge/state/credentials.dpapi`。
3. 页面下方“状态”显示 Slack 和 Weixin 均已加密保存后，回到终端按 `Ctrl + C` 停止 `setup.mjs`。

> ⚠️ **安全说明**：`credentials.dpapi` 与当前 Windows 登录用户绑定。如果你计划以 Windows 计划任务运行，请确保授权和运行使用**同一个 Windows 用户账号**。

---

### 第 6 步：校验并启动桥接服务

#### 1. 只读预检（不发送任何消息）

```powershell
cd bridge
npm run relay:check
# 或查看详细的 MCP 文件工具能力：
node scripts/mcp-preflight.mjs
```

返回 `readOnlyCheckPassed: true` 且 `sendToolAvailable: true`、`fileUploadAvailable: true` 即表示授权与连通性就绪。

#### 2. 查看状态 / 单次拉取 / 仅接收模式

```powershell
# 查看队列与绑定状态（只读，不加进程锁）
npm run relay:status

# 单次拉取微信新消息测试
node src/connector-main.mjs --receive-once

# 仅接收不转发模式（验证微信长轮询）
npm run relay:receive
```

#### 3. 启动完整双向转发

```powershell
npm start
# 等价于：node src/connector-main.mjs --forward
```

---

### 第 7 步：配置后台常驻运行（Windows 计划任务）

仓库自带带指数退避重启的守护脚本 [`bridge/scripts/run-relay.ps1`](bridge/scripts/run-relay.ps1)，可将输出写入 `relay-output.log` / `relay-error.log` / `relay-supervisor.log`。

直接手动后台测试：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\NewProjects\PersonalAssistant\bridge\scripts\run-relay.ps1"
```

如需开机/登录自启，可在 Windows 任务计划程序（Task Scheduler）中新建任务：
- **运行账户**：与执行 `setup.mjs` 相同的 Windows 用户（DPAPI 解密必需）。
- **程序/脚本**：`powershell.exe`
- **参数**：`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<你的路径>\PersonalAssistant\bridge\scripts\run-relay.ps1"`

#### 优雅停机

无需强杀进程，只需在 `bridge/state/` 下创建一个空的 `relay.stop` 文件：

```powershell
New-Item -ItemType File -Path .\bridge\state\relay.stop -Force
```

主循环与守护脚本检测到 `state/relay.stop` 后会自动保存状态并安全退出。恢复运行前删除该文件即可：

```powershell
Remove-Item .\bridge\state\relay.stop -Force
```

---

## 常用运维与排查命令

| 命令 | 说明 |
| --- | --- |
| `npm test` | 运行全部离线单元测试（不联网、不发真实消息） |
| `npm run relay:status` | 输出当前绑定队列摘要（待发送任务数、已发送数、异常状态等） |
| `npm run relay:check` | 执行 Slack `auth.test`、MCP 初始化与只读线程核验 |
| `node scripts/mcp-preflight.mjs` | 检查当前 Token 的 OAuth Scopes 及 MCP 文件读写工具列表 |
| `node scripts/inspect-network-route.mjs` | 检查当前网络路由配置 |
| `node scripts/check-network.mjs` | 基础网络连通性探测 |

运行期间健康状态快照会定期原子写入 `bridge/state/health.json`。

---

## 常见问题

- **`windows_dpapi_required` / `dpapi_operation_failed`**：本工具仅支持 Windows，且必须由生成 `credentials.dpapi` 的同一 Windows 用户账号运行。
- **`authorization_incomplete`**：尚未完成 Slack 授权或微信扫码绑定，请运行 `node src/setup.mjs` 完成配置。
- **`connector_file_permission_required`**：Slack Token 缺少 `files:read` / `files:write` 权限。在 Slack App 的 **User Token Scopes** 补齐后，务必点击 **Reinstall to Workspace**，再用新生成的 `xoxp-` Token 在本机配置页重新保存。
- **`bridge_already_running`**：已有另一个桥接实例正在运行（`bridge/state/bridge.lock` 持有活跃 PID）。
- **`relay_stopped`**：存在 `bridge/state/relay.stop` 停机标志文件，确认安全后删除即可重新启动。
