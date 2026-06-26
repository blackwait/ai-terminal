import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const tabsEl = document.getElementById("tabs");
const terminalsEl = document.getElementById("terminals");
const emptyHint = document.getElementById("empty-hint");

// ===== 工作目录侧栏 =====
const currentDirEl = document.getElementById("current-dir");
const defaultDirEl = document.getElementById("default-dir");
const recentListEl = document.getElementById("recent-list");
const pickDirBtn = document.getElementById("pick-dir");
const setDefaultBtn = document.getElementById("set-default");

/** 当前选中的工作目录（null 表示使用用户主目录） */
let currentDir = null;
/** 已设置的默认目录（null 表示未设置） */
let defaultDir = null;

/** 取路径最后一段做显示名 */
function baseName(p) {
  if (!p) return "";
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** 渲染「当前目录」 */
function renderCurrent() {
  if (currentDir) {
    currentDirEl.textContent = currentDir;
    currentDirEl.title = currentDir;
    currentDirEl.classList.remove("muted");
  } else {
    currentDirEl.textContent = "用户主目录 (~)";
    currentDirEl.title = "";
    currentDirEl.classList.add("muted");
  }
}

/** 渲染「默认目录」 */
function renderDefault() {
  if (defaultDir) {
    defaultDirEl.textContent = defaultDir;
    defaultDirEl.title = defaultDir;
    defaultDirEl.classList.remove("muted");
  } else {
    defaultDirEl.textContent = "未设置（使用主目录）";
    defaultDirEl.title = "";
    defaultDirEl.classList.add("muted");
  }
}

/** 渲染最近使用列表 */
function renderRecent(dirs) {
  recentListEl.innerHTML = "";
  if (!dirs || dirs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sb-recent-empty";
    empty.textContent = "暂无记录";
    recentListEl.appendChild(empty);
    return;
  }
  for (const dir of dirs) {
    const item = document.createElement("div");
    item.className = "sb-recent-item";
    item.title = dir;
    item.innerHTML = `
      <span class="ri-name">${baseName(dir)}</span>
      <span class="ri-path">${dir}</span>`;
    if (dir === defaultDir) item.classList.add("is-default");
    item.addEventListener("click", () => {
      currentDir = dir;
      renderCurrent();
      highlightActiveRecent();
    });
    recentListEl.appendChild(item);
  }
  highlightActiveRecent();
}

/** 高亮当前选中目录对应的最近项 */
function highlightActiveRecent() {
  for (const el of recentListEl.querySelectorAll(".sb-recent-item")) {
    el.classList.toggle("active", el.title === currentDir);
  }
}

/** 应用后端返回的配置 */
function applyConfig(cfg) {
  defaultDir = cfg?.defaultDir || null;
  renderDefault();
  renderRecent(cfg?.recentDirs || []);
}

/** 选择文件夹 */
async function pickDirectory() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: currentDir || defaultDir || undefined,
      title: "选择工作目录",
    });
    if (typeof selected === "string" && selected) {
      currentDir = selected;
      renderCurrent();
      const cfg = await invoke("add_recent_dir", { dir: selected });
      applyConfig(cfg);
      highlightActiveRecent();
    }
  } catch (err) {
    console.error("选择文件夹失败:", err);
  }
}

/** 把当前目录设为默认 */
async function applyAsDefault() {
  if (!currentDir) {
    // 没有显式选择时，无法设默认；提示用户先选文件夹
    pickDirBtn.classList.add("shake");
    setTimeout(() => pickDirBtn.classList.remove("shake"), 400);
    return;
  }
  try {
    const cfg = await invoke("set_default_dir", { dir: currentDir });
    applyConfig(cfg);
    highlightActiveRecent();
  } catch (err) {
    console.error("设置默认目录失败:", err);
  }
}

/** 初始化目录配置 */
async function initDirConfig() {
  try {
    const cfg = await invoke("get_dir_config");
    applyConfig(cfg);
    // 默认把「当前目录」指向默认目录
    currentDir = defaultDir;
    renderCurrent();
    highlightActiveRecent();
  } catch (err) {
    console.error("读取目录配置失败:", err);
  }
}

pickDirBtn.addEventListener("click", pickDirectory);
setDefaultBtn.addEventListener("click", applyAsDefault);

// ===== AI 工具配置 =====
const aiToolTabs = document.querySelectorAll(".ai-tool-tab");
const aiBaseUrl = document.getElementById("ai-base-url");
const aiApiKey = document.getElementById("ai-api-key");
const aiModel = document.getElementById("ai-model");
const aiApplyBtn = document.getElementById("ai-apply-btn");
const aiConfigStatus = document.getElementById("ai-config-status");
let currentAiTool = "codex";

async function loadAiConfig(tool) {
  try {
    const cfg = await invoke("read_ai_config", { tool });
    aiBaseUrl.value = cfg.baseUrl || "";
    aiApiKey.value = cfg.apiKey || "";
    aiModel.value = cfg.model || "";
    aiConfigStatus.textContent = "";
    aiConfigStatus.className = "ai-config-status";
  } catch (err) {
    aiBaseUrl.value = "";
    aiApiKey.value = "";
    aiModel.value = "";
    aiConfigStatus.textContent = `读取失败: ${err}`;
    aiConfigStatus.className = "ai-config-status error";
  }
}

aiToolTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    aiToolTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentAiTool = tab.dataset.tool;
    loadAiConfig(currentAiTool);
  });
});

aiApplyBtn.addEventListener("click", async () => {
  try {
    await invoke("write_ai_config", {
      tool: currentAiTool,
      config: {
        baseUrl: aiBaseUrl.value.trim(),
        apiKey: aiApiKey.value.trim(),
        model: aiModel.value.trim(),
      },
    });
    aiConfigStatus.textContent = "已保存";
    aiConfigStatus.className = "ai-config-status success";
    setTimeout(() => {
      aiConfigStatus.textContent = "";
      aiConfigStatus.className = "ai-config-status";
    }, 2000);
  } catch (err) {
    aiConfigStatus.textContent = `保存失败: ${err}`;
    aiConfigStatus.className = "ai-config-status error";
  }
});

loadAiConfig(currentAiTool);


/** 会话集合 id -> session */
const sessions = new Map();
let activeId = null;
const kindCounters = { kiro: 0, codex: 0, claude: 0, mimo: 0 };

const KIND_LABEL = { kiro: "Kiro", codex: "Codex", claude: "Claude Code", mimo: "MiMo" };

const TERM_THEME = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

function syncImeTextarea(session) {
  const { term } = session;
  const textarea = term.textarea;
  const screen = term.element?.querySelector(".xterm-screen");
  if (!textarea || !screen || term.cols <= 0 || term.rows <= 0) return;

  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const buffer = term.buffer.active;
  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  const cursorX = Math.min(Math.max(buffer.cursorX, 0), term.cols - 1);
  const cursorY = Math.min(Math.max(buffer.cursorY, 0), term.rows - 1);

  textarea.style.left = `${cursorX * cellWidth}px`;
  textarea.style.top = `${cursorY * cellHeight}px`;
  textarea.style.width = `${Math.max(cellWidth, 1)}px`;
  textarea.style.height = `${Math.max(cellHeight, 1)}px`;
  textarea.style.lineHeight = `${Math.max(cellHeight, 1)}px`;
}

function attachImeTextareaSync(session) {
  const sync = () => syncImeTextarea(session);
  const textarea = session.term.textarea;
  const disposers = [
    session.term.onCursorMove(sync),
    session.term.onRender(sync),
    session.term.onResize(sync),
  ];

  if (textarea) {
    const syncSoon = () => requestAnimationFrame(sync);
    textarea.addEventListener("focus", sync);
    textarea.addEventListener("keydown", syncSoon, true);
    textarea.addEventListener("compositionstart", sync, true);
    disposers.push({
      dispose() {
        textarea.removeEventListener("focus", sync);
        textarea.removeEventListener("keydown", syncSoon, true);
        textarea.removeEventListener("compositionstart", sync, true);
      },
    });
  }

  session.imeDisposers = disposers;
  sync();
}

function uid() {
  return "s_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function updateEmptyHint() {
  emptyHint.classList.toggle("hidden", sessions.size > 0);
}

/** 创建一个新会话 */
async function newSession(kind) {
  const id = uid();
  kindCounters[kind] += 1;
  const defaultName = `${KIND_LABEL[kind]} ${kindCounters[kind]}`;

  // ----- 终端面板 -----
  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.dataset.id = id;
  terminalsEl.appendChild(pane);

  // ----- 标签 -----
  const tab = document.createElement("div");
  tab.className = `tab kind-${kind}`;
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="tab-dot"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="关闭">×</span>`;
  const titleEl = tab.querySelector(".tab-title");
  tabsEl.appendChild(tab);

  // ----- xterm 实例 -----
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: TERM_THEME,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(pane);

  const session = {
    id,
    kind,
    term,
    fitAddon,
    pane,
    tab,
    titleEl,
    defaultName,
    lineBuf: "",
    customTitle: "",
  };
  sessions.set(id, session);
  setTitle(session, defaultName);
  attachImeTextareaSync(session);

  // ----- 输入：写回 PTY + 维护标签名 -----
  term.onData((data) => {
    invoke("write_session", { id, data }).catch(console.error);
    trackInput(session, data);
  });

  // ----- 交互绑定 -----
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    activate(id);
  });
  tab.querySelector(".tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(id);
  });

  // ----- 监听后端输出 -----
  session.unlistenOutput = await listen(`pty://output/${id}`, (event) => {
    const payload = event.payload;
    if (payload instanceof Array) {
      term.write(new Uint8Array(payload));
    } else if (typeof payload === "string") {
      term.write(payload);
    }
  });
  session.unlistenExit = await listen(`pty://exit/${id}`, () => {
    term.write("\r\n\x1b[90m[进程已退出]\x1b[0m\r\n");
  });

  updateEmptyHint();
  activate(id);

  // 先适配尺寸，再用真实行列创建后端 PTY
  requestAnimationFrame(async () => {
    fit(session);
    const { cols, rows } = term;
    try {
      await invoke("create_session", { id, kind, cols, rows, cwd: currentDir });
    } catch (err) {
      term.write(`\r\n\x1b[31m创建会话失败: ${err}\x1b[0m\r\n`);
    }
    term.focus();
  });
}

/** 根据用户输入更新标签名 */
function trackInput(session, data) {
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (ch === "\r" || ch === "\n") {
      // 回车：把当前输入行固化为标签名
      const line = session.lineBuf.trim();
      if (line) {
        session.customTitle = line;
        setTitle(session, line);
      }
      session.lineBuf = "";
    } else if (ch === "\x7f" || ch === "\b") {
      // 退格
      session.lineBuf = session.lineBuf.slice(0, -1);
      refreshLiveTitle(session);
    } else if (code === 0x1b) {
      // ESC 序列（方向键等）：忽略，不计入标题
      break;
    } else if (code < 0x20) {
      // 其它控制字符忽略（含 Ctrl 组合、Tab）
      continue;
    } else {
      session.lineBuf += ch;
      refreshLiveTitle(session);
    }
  }
}

/** 输入过程中实时反映到标签 */
function refreshLiveTitle(session) {
  const live = session.lineBuf.trim();
  if (live) {
    setTitle(session, live);
  } else {
    setTitle(session, session.customTitle || session.defaultName);
  }
}

function setTitle(session, text) {
  const max = 28;
  const shown = text.length > max ? text.slice(0, max) + "…" : text;
  session.titleEl.textContent = shown;
  session.tab.title = text;
  if (session.id === activeId) {
    document.title = `${shown} — AI Terminal`;
  }
}

/** 激活某个会话 */
function activate(id) {
  if (activeId === id) {
    sessions.get(id)?.term.focus();
    return;
  }
  activeId = id;
  for (const [sid, s] of sessions) {
    const on = sid === id;
    s.pane.classList.toggle("active", on);
    s.tab.classList.toggle("active", on);
  }
  const s = sessions.get(id);
  if (s) {
    requestAnimationFrame(() => {
      fit(s);
      s.term.focus();
      document.title = `${s.titleEl.textContent} — AI Terminal`;
    });
  }
}

/** 关闭会话 */
async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    await invoke("close_session", { id });
  } catch (e) {
    console.error(e);
  }
  s.unlistenOutput?.();
  s.unlistenExit?.();
  s.imeDisposers?.forEach((d) => d.dispose?.());
  s.term.dispose();
  s.pane.remove();
  s.tab.remove();
  sessions.delete(id);

  if (activeId === id) {
    activeId = null;
    const next = [...sessions.keys()].pop();
    if (next) activate(next);
    else document.title = "AI Terminal";
  }
  updateEmptyHint();
}

/** 适配尺寸并通知后端 resize */
function fit(session) {
  try {
    session.fitAddon.fit();
    syncImeTextarea(session);
    const { cols, rows } = session.term;
    invoke("resize_session", { id: session.id, cols, rows }).catch(() => {});
  } catch (_) {
    /* 面板隐藏时 fit 可能抛错，忽略 */
  }
}

// 窗口尺寸变化时重排当前会话
window.addEventListener("resize", () => {
  const s = sessions.get(activeId);
  if (s) fit(s);
});

// 顶部新建按钮
document.querySelectorAll(".new-btn").forEach((btn) => {
  btn.addEventListener("click", () => newSession(btn.dataset.kind));
});

updateEmptyHint();
initDirConfig();
