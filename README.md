# AI Terminal

面向本机 AI CLI 的多项目工作台：在选定工作目录下，一键打开 **Kiro / Codex / Claude / MiMo / Shell** 多标签终端，并统一管理 API 配置与启动参数。

基于 **Tauri 2 + xterm.js + portable-pty**。

---

## 环境要求

- macOS（主要验证平台；Windows/Linux 有部分兼容代码）
- Node.js 18+
- Rust（Tauri 构建需要）
- 已安装并加入 PATH 的 AI CLI（按需）：
  - `kiro-cli`
  - `codex`
  - `claude`
  - `mimo`

> GUI 启动时 PATH 可能不完整，应用会自动合并常见路径（`/opt/homebrew/bin`、`~/.local/bin`、`~/.cargo/bin` 等）。

---

## 开发与运行

```bash
cd /Users/black/IdeaProjects/vibeCoding/ai-terminal
npm install
npm run tauri dev
```

仅前端：

```bash
npm run dev
```

打包：

```bash
npm run tauri build
```

---

## 功能概览

| 模块 | 能力 |
|------|------|
| 工作区 | 选择目录、默认目录、最近列表、钉住、Finder 显示、**侧栏筛选（⌘P）** |
| 会话 | 多标签、分屏、拖拽排序、双击重命名、**重启（⌘⇧R）**、**续聊（⌘⇧T / ⌘⌥T）**、**标签右键批量关闭** |
| 状态 | 标签三态（蓝灰空闲 / 黄执行 / 绿完成）；静默完成与退出 **系统通知** |
| 终端 | 搜索、字号持久化、选择即复制、右键菜单、导出日志 |
| AI 配置 | 读写 Codex/Claude/MiMo 本地配置、配置档案、连通测试 |
| 启动 | 可配置 CLI 命令、自动注入开关、注入延迟、纯 Shell |
| 状态栏 | cwd、**Git 分支**、工具、运行状态、行列、字号 |

---

## 快捷键

| 快捷键 | 作用 |
|--------|------|
| `⌘T` | 新建上次使用的工具会话 |
| `⌘⇧T` | **续聊**最近会话（上次工具，走 CLI resume） |
| `⌘⌥T` | **续聊**打开会话选择器（上次工具） |
| `⌘⇧K` | 新建 Kiro |
| `⌘W` | 关闭当前标签 |
| `⌘⇧R` | 重启当前会话（同工具 / 同目录 / 保留自定义标题与续聊模式） |
| `⌘P` | 聚焦侧栏「筛选项目」 |
| `⌘1`–`⌘9` | 切换到第 N 个标签 |
| `⌘Tab` / `⌘⇧Tab` | 下一个 / 上一个标签 |
| `⌘F` | 终端内搜索 |
| `⌘+` / `⌘-` / `⌘0` | 增大 / 减小 / 重置字号 |
| `⌘B` | 折叠 / 展开侧栏 |
| `⌘,` | 打开设置 |
| `⌘K` | 命令面板 |
| `⌘\` | 左右分屏 / 取消分屏 |
| 标签右键 | 关闭 / 关闭左侧 / 关闭右侧 / 关闭其他 / 关闭全部 |
| `Esc` | 关闭弹层 / 搜索 / 右键菜单 |

（Windows/Linux 上 `⌘` 对应 `Ctrl`。）

---

## 默认启动命令

新装或未自定义时：

| 工具 | 默认命令 |
|------|----------|
| Kiro | `kiro-cli` |
| Codex | `codex` |
| Claude | `claude --permission-mode bypassPermissions --tools default` |
| MiMo | `mimo --trust --never-ask` |

可在 **设置 → 启动参数** 中改成更保守的命令（例如仅 `claude` / `mimo`）。

---

## 配置存储

| 内容 | 位置 |
|------|------|
| 应用偏好（目录、字号、启动参数、档案等） | 系统 app config 目录下 `app-config.json`（兼容旧 `dir-config.json`） |
| Codex | `~/.codex/config.toml`、`~/.codex/auth.json`（合并写入，不整文件覆盖） |
| Claude | `~/.claude/settings.json` 的 `env` 字段（合并写入） |
| MiMo | `~/.local/share/mimocode/auth.json`、`~/.mimocode/config.toml` |

保存 AI 配置后，**已打开的会话不会自动重读**；请新建会话生效。

---

## 权限与安全说明

- 应用会启动本地 shell / AI CLI，并写入你本机的 CLI 配置文件。
- API Key 在界面中默认遮罩显示；仍以明文形式写在各工具自己的配置文件中（与 CLI 生态一致）。
- Claude/MiMo 默认启用最高权限（bypass / trust / never-ask）；可在设置中改保守。
- 关闭标签或退出应用时会终止对应 PTY 子进程。

---

## 续聊（打开之前的会话）

终端滚动缓冲**不会**跨进程完整回放；对话历史由各 AI CLI 自己的 session store 保存。本应用通过注入 resume 命令接回上下文：

| 工具 | 最近会话 | 选择会话 |
|------|----------|----------|
| Codex | `codex resume --last` | `codex resume` |
| Kiro | `kiro-cli --resume` | `kiro-cli --resume-picker` |
| Claude | `claude --continue` | `claude --resume` |
| MiMo | `mimo --continue --trust --never-ask` | 进入 MiMo TUI 后自选 |

入口：工具栏 **↩ 续聊 / ☰ 选会话**、命令面板「续聊…」、快捷键 `⌘⇧T` / `⌘⌥T`。  
设置里勾选 **启动时恢复上次会话列表** 时，AI 标签会默认用「最近会话」resume 拉起（可接着调用工具与上下文）。

---

## 常见问题

**创建会话提示找不到命令**

1. 设置 → 通用 → 重新检测 CLI  
2. 确认 CLI 已安装：`which codex` / `which claude` …  
3. 可先用 **+ Shell**，在终端里手动执行命令排查 PATH  

**自动启动的 CLI 没起来**

- 增大 **设置 → 启动参数 → 注入延迟**（默认 400ms）  
- 或关闭「自动启动 AI」，用 Shell 手动启动  

**Git 分支不显示**

- 当前目录不是 git 仓库，或本机没有 `git`  
- 状态栏显示 `—` 属正常  

---

## 版本

当前版本见 `package.json` / `src-tauri/tauri.conf.json`（0.3.x）。
