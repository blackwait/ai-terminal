import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const tabsEl = document.getElementById("tabs");
const terminalsEl = document.getElementById("terminals");
const emptyHint = document.getElementById("empty-hint");
const sidebarEl = document.getElementById("sidebar");
const sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
const sidebarExpandBtn = document.getElementById("sidebar-expand-btn");
const currentDirEl = document.getElementById("current-dir");
const defaultDirEl = document.getElementById("default-dir");
const recentListEl = document.getElementById("recent-list");
const pinnedListEl = document.getElementById("pinned-list");
const pickDirBtn = document.getElementById("pick-dir");
const setDefaultBtn = document.getElementById("set-default");
const clearRecentBtn = document.getElementById("clear-recent");
const openSettingsBtn = document.getElementById("open-settings-btn");
const cmdPaletteBtn = document.getElementById("cmd-palette-btn");
const dirFilterInput = document.getElementById("dir-filter");

const statusCwd = document.getElementById("status-cwd");
const statusBranch = document.getElementById("status-branch");
const statusKind = document.getElementById("status-kind");
const statusState = document.getElementById("status-state");
const statusSize = document.getElementById("status-size");
const statusFont = document.getElementById("status-font");
const termContextMenu = document.getElementById("term-context-menu");
const tabContextMenu = document.getElementById("tab-context-menu");
const ctxCopyOnSelectBtn = document.getElementById("ctx-copy-on-select");
/** 右键刚打开菜单后，浏览器常会再派发 click，需忽略一次以免立刻关掉 */
let suppressDocumentClickUntil = 0;

const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const searchPrev = document.getElementById("search-prev");
const searchNext = document.getElementById("search-next");
const searchClose = document.getElementById("search-close");

const settingsModal = document.getElementById("settings-modal");
const commandPalette = document.getElementById("command-palette");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
const confirmModal = document.getElementById("confirm-modal");
const confirmMessage = document.getElementById("confirm-message");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

const aiBaseUrl = document.getElementById("ai-base-url");
const aiApiKey = document.getElementById("ai-api-key");
const aiModel = document.getElementById("ai-model");
const aiApplyBtn = document.getElementById("ai-apply-btn");
const aiTestBtn = document.getElementById("ai-test-btn");
const aiConfigStatus = document.getElementById("ai-config-status");
const toggleApiKeyBtn = document.getElementById("toggle-api-key");

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
/** @type {Map<string, any>} */
const sessions = new Map();
/** 标签顺序（支持拖拽排序） */
let tabOrder = [];
let activeId = null;
/** 分屏时右侧会话 id */
let splitId = null;
let currentDir = null;
let defaultDir = null;
let pinnedDirs = [];
let recentDirs = [];
let appConfig = null;
let fontSize = 13;
let lastKind = "codex";
let currentAiTool = "codex";
let confirmResolver = null;
let paletteIndex = 0;
let paletteCommands = [];
let dragTabId = null;
let copyOnSelect = true;
let contextMenuSessionId = null;
/** 标签右键菜单对应的会话 id */
let tabContextSessionId = null;
// uiThemeId 在 UI_THEMES 定义处初始化
/** 侧栏项目筛选关键词 */
let dirFilterQuery = "";
/** 后台会话退出时是否系统通知 */
let notifyOnExit = true;
/** 任务静默完成后是否系统通知 */
let notifyOnTaskDone = true;
/** 会话输出静默计时器 id -> timer（running → done） */
const activityIdleTimers = new Map();
/**
 * 有输出后多久无新输出视为「本轮完成」。
 * 过短会把 CLI 思考间隙误判为完成；过长反馈慢。
 */
const TASK_DONE_IDLE_MS = 4500;
/** 累计输出少于此字节数时，静默后回到 idle 而不是 done（过滤壳提示符抖动） */
const MIN_OUTPUT_BYTES_FOR_DONE = 64;
/** 目录 -> 分支缓存，避免频繁调 git */
const gitBranchCache = new Map();
let gitBranchRequestToken = 0;
const NOTIFY_EXIT_STORAGE_KEY = "ai-terminal.notifyOnExit";
const NOTIFY_TASK_DONE_STORAGE_KEY = "ai-terminal.notifyOnTaskDone";

/** 会话活动态：idle 空闲 / running 执行中 / done 本轮完成 */
const SESSION_ACTIVITY = {
  idle: "idle",
  running: "running",
  done: "done",
};

const KIND_LABEL = {
  kiro: "Kiro",
  codex: "Codex",
  claude: "Claude",
  mimo: "MiMo",
  shell: "Shell",
};

/** 终端字体：等宽 + 科技感 */
const TERM_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace';

/**
 * 多套科技主题：外壳用 data-theme CSS 变量，终端用 xterm theme 同步。
 * id 与后端 normalize_ui_theme 保持一致。
 */
const UI_THEMES = [
  {
    id: "cyberpunk",
    name: "赛博霓虹",
    desc: "品红 × 青绿 · 默认 HUD",
    swatches: ["#00ff9c", "#ff2bd6", "#00f0ff"],
    term: {
      background: "#000000",
      foreground: "#c8ffe8",
      cursor: "#00ff9c",
      cursorAccent: "#000000",
      selectionBackground: "#1a0033",
      selectionForeground: "#e8fff6",
      selectionInactiveBackground: "#12001f",
      black: "#0a0a0f",
      red: "#ff3366",
      green: "#00ff9c",
      yellow: "#f5ff7a",
      blue: "#3d7eff",
      magenta: "#ff2bd6",
      cyan: "#00f0ff",
      white: "#d0e8e0",
      brightBlack: "#5a6a72",
      brightRed: "#ff6b9d",
      brightGreen: "#5dffb8",
      brightYellow: "#ffff9a",
      brightBlue: "#7aa8ff",
      brightMagenta: "#ff7ae8",
      brightCyan: "#7dffff",
      brightWhite: "#f0fff8",
    },
  },
  {
    id: "matrix",
    name: "矩阵代码",
    desc: "经典绿磷光 · 黑客终端",
    swatches: ["#00ff66", "#39ff14", "#0aff9d"],
    term: {
      background: "#000000",
      foreground: "#b8ffb8",
      cursor: "#00ff66",
      cursorAccent: "#000000",
      selectionBackground: "#003318",
      selectionForeground: "#e8ffe8",
      selectionInactiveBackground: "#001a0c",
      black: "#001a0a",
      red: "#ff4455",
      green: "#00ff66",
      yellow: "#c8ff4a",
      blue: "#3dcc7a",
      magenta: "#66ff99",
      cyan: "#4dffc3",
      white: "#c8e8c8",
      brightBlack: "#3d5c45",
      brightRed: "#ff7788",
      brightGreen: "#66ff99",
      brightYellow: "#e0ff80",
      brightBlue: "#7ae0a8",
      brightMagenta: "#99ffbb",
      brightCyan: "#80ffe0",
      brightWhite: "#f0fff0",
    },
  },
  {
    id: "arctic",
    name: "极地冰蓝",
    desc: "冷青 × 冰蓝 · 深空控制台",
    swatches: ["#4cc9ff", "#7aa2ff", "#00e5ff"],
    term: {
      background: "#02060c",
      foreground: "#d6ecff",
      cursor: "#4cc9ff",
      cursorAccent: "#02060c",
      selectionBackground: "#0a2744",
      selectionForeground: "#f0f8ff",
      selectionInactiveBackground: "#061828",
      black: "#071018",
      red: "#ff5d7a",
      green: "#3dffb5",
      yellow: "#ffe08a",
      blue: "#4c8dff",
      magenta: "#b48cff",
      cyan: "#4cc9ff",
      white: "#d0e4f5",
      brightBlack: "#5a7388",
      brightRed: "#ff8aa0",
      brightGreen: "#7dffcb",
      brightYellow: "#ffeeb0",
      brightBlue: "#7aafff",
      brightMagenta: "#cbb0ff",
      brightCyan: "#8ae0ff",
      brightWhite: "#f4faff",
    },
  },
  {
    id: "plasma",
    name: "等离子紫",
    desc: "电光紫 × 玫红 · 能量脉冲",
    swatches: ["#c77dff", "#ff4fd8", "#9b5cff"],
    term: {
      background: "#07030f",
      foreground: "#f0e6ff",
      cursor: "#c77dff",
      cursorAccent: "#07030f",
      selectionBackground: "#2a1050",
      selectionForeground: "#fff0ff",
      selectionInactiveBackground: "#180a30",
      black: "#100818",
      red: "#ff4d7a",
      green: "#7dffb2",
      yellow: "#ffd56a",
      blue: "#7a8cff",
      magenta: "#ff4fd8",
      cyan: "#8ce0ff",
      white: "#e8dcff",
      brightBlack: "#6a5a80",
      brightRed: "#ff8aa8",
      brightGreen: "#a8ffd0",
      brightYellow: "#ffe499",
      brightBlue: "#a8b4ff",
      brightMagenta: "#ff8ae8",
      brightCyan: "#b0f0ff",
      brightWhite: "#faf5ff",
    },
  },
  {
    id: "amber",
    name: "琥珀终端",
    desc: "暖琥珀 × 橙 · 复古 CRT",
    swatches: ["#ffb000", "#ff8c1a", "#ffd166"],
    term: {
      background: "#0a0702",
      foreground: "#ffd9a0",
      cursor: "#ffb000",
      cursorAccent: "#0a0702",
      selectionBackground: "#3a2200",
      selectionForeground: "#fff3d6",
      selectionInactiveBackground: "#241500",
      black: "#14100a",
      red: "#ff5a3c",
      green: "#c8e06a",
      yellow: "#ffb000",
      blue: "#ff9a4a",
      magenta: "#ff7a40",
      cyan: "#ffcc66",
      white: "#f0d8b0",
      brightBlack: "#7a6550",
      brightRed: "#ff8a70",
      brightGreen: "#e0f090",
      brightYellow: "#ffd060",
      brightBlue: "#ffb878",
      brightMagenta: "#ff9a70",
      brightCyan: "#ffe099",
      brightWhite: "#fff6e8",
    },
  },
  {
    id: "holographic",
    name: "全息虹彩",
    desc: "青 × 粉 × 紫 · 全息投影",
    swatches: ["#00f5d4", "#f15bb5", "#9b5de5"],
    term: {
      background: "#05050a",
      foreground: "#e8f4ff",
      cursor: "#00f5d4",
      cursorAccent: "#05050a",
      selectionBackground: "#1a1040",
      selectionForeground: "#ffffff",
      selectionInactiveBackground: "#100a28",
      black: "#0c0c14",
      red: "#ff5d8f",
      green: "#00f5d4",
      yellow: "#fee440",
      blue: "#00bbf9",
      magenta: "#f15bb5",
      cyan: "#00f5d4",
      white: "#e0e8f5",
      brightBlack: "#5a6478",
      brightRed: "#ff8ab0",
      brightGreen: "#7dffe8",
      brightYellow: "#fff07a",
      brightBlue: "#66d4ff",
      brightMagenta: "#ff8ad0",
      brightCyan: "#80fff0",
      brightWhite: "#f8fbff",
    },
  },
];

const DEFAULT_UI_THEME = "cyberpunk";
let uiThemeId = DEFAULT_UI_THEME;

function normalizeUiThemeId(themeId) {
  const normalized = String(themeId || "")
    .trim()
    .toLowerCase();
  return UI_THEMES.some((theme) => theme.id === normalized)
    ? normalized
    : DEFAULT_UI_THEME;
}

function getUiTheme(themeId = uiThemeId) {
  const id = normalizeUiThemeId(themeId);
  return UI_THEMES.find((theme) => theme.id === id) || UI_THEMES[0];
}

function getTermTheme(themeId = uiThemeId) {
  return getUiTheme(themeId).term;
}

function applyUiTheme(themeId, { persist = false } = {}) {
  uiThemeId = normalizeUiThemeId(themeId);
  document.documentElement.setAttribute("data-theme", uiThemeId);
  const termTheme = getTermTheme(uiThemeId);
  for (const session of sessions.values()) {
    session.term.options.theme = termTheme;
  }
  renderThemeGrid();
  if (persist) {
    invoke("update_prefs", { patch: { uiTheme: uiThemeId } })
      .then((cfg) => {
        appConfig = cfg;
        const status = document.getElementById("theme-status");
        if (status) {
          status.textContent = `已切换：${getUiTheme(uiThemeId).name}`;
          status.className = "ai-config-status success";
        }
      })
      .catch((err) => {
        const status = document.getElementById("theme-status");
        if (status) {
          status.textContent = String(err);
          status.className = "ai-config-status error";
        }
      });
  }
}

function renderThemeGrid() {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const theme of UI_THEMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `theme-card${theme.id === uiThemeId ? " active" : ""}`;
    card.dataset.themeId = theme.id;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", theme.id === uiThemeId ? "true" : "false");
    card.title = theme.desc;

    const preview = document.createElement("div");
    preview.className = "theme-card-preview";
    preview.style.background = `linear-gradient(135deg, ${theme.swatches[0]} 0%, ${theme.swatches[1]} 55%, ${theme.swatches[2]} 100%)`;

    const swatchRow = document.createElement("div");
    swatchRow.className = "theme-card-swatches";
    for (const color of theme.swatches) {
      const dot = document.createElement("span");
      dot.className = "theme-swatch";
      dot.style.background = color;
      swatchRow.appendChild(dot);
    }

    const meta = document.createElement("div");
    meta.className = "theme-card-meta";
    const name = document.createElement("div");
    name.className = "theme-card-name";
    name.textContent = theme.name;
    const desc = document.createElement("div");
    desc.className = "theme-card-desc";
    desc.textContent = theme.desc;
    meta.append(name, desc);

    card.append(preview, swatchRow, meta);
    card.addEventListener("click", () => {
      applyUiTheme(theme.id, { persist: true });
    });
    grid.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function baseName(pathValue) {
  if (!pathValue) return "~";
  const parts = pathValue.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || pathValue;
}

function projectLabel(cwd) {
  return cwd ? baseName(cwd) : "~";
}

function defaultSessionTitle(kind, cwd) {
  return `${projectLabel(cwd)} · ${KIND_LABEL[kind] || kind}`;
}

function uid() {
  return "s_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function modKey(event) {
  return event.metaKey || event.ctrlKey;
}

function loadBoolPref(storageKey, defaultValue = true) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultValue;
    return raw === "1" || raw === "true";
  } catch (_) {
    return defaultValue;
  }
}

function saveBoolPref(storageKey, enabled) {
  try {
    localStorage.setItem(storageKey, enabled ? "1" : "0");
  } catch (_) {
    /* ignore quota */
  }
}

function loadNotifyOnExitPref() {
  return loadBoolPref(NOTIFY_EXIT_STORAGE_KEY, true);
}

function saveNotifyOnExitPref(enabled) {
  notifyOnExit = !!enabled;
  saveBoolPref(NOTIFY_EXIT_STORAGE_KEY, notifyOnExit);
}

function loadNotifyOnTaskDonePref() {
  return loadBoolPref(NOTIFY_TASK_DONE_STORAGE_KEY, true);
}

function saveNotifyOnTaskDonePref(enabled) {
  notifyOnTaskDone = !!enabled;
  saveBoolPref(NOTIFY_TASK_DONE_STORAGE_KEY, notifyOnTaskDone);
}

function dirMatchesFilter(dir) {
  const query = dirFilterQuery.trim().toLowerCase();
  if (!query) return true;
  const name = baseName(dir).toLowerCase();
  const full = String(dir || "").toLowerCase();
  return name.includes(query) || full.includes(query);
}

function clearSessionActivityTimer(sessionId) {
  const timer = activityIdleTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  activityIdleTimers.delete(sessionId);
}

function activityStateLabel(state) {
  switch (state) {
    case SESSION_ACTIVITY.running:
      return "执行中";
    case SESSION_ACTIVITY.done:
      return "已完成";
    case SESSION_ACTIVITY.idle:
    default:
      return "空闲";
  }
}

/**
 * 同步标签圆点颜色：空闲蓝灰 / 执行中黄 / 完成绿 / 已退出灰。
 * @param {any} session
 * @param {"idle"|"running"|"done"} nextState
 * @param {{ notify?: boolean }} [options]
 */
function applySessionActivityState(session, nextState, options = {}) {
  if (!session || !session.tab) return;
  const previousState = session.activityState || SESSION_ACTIVITY.idle;
  const state = nextState || SESSION_ACTIVITY.idle;
  session.activityState = state;

  session.tab.classList.remove(
    "state-idle",
    "state-running",
    "state-done",
    "busy"
  );
  if (!session.exited) {
    session.tab.classList.add(`state-${state}`);
  }

  const titleBase = session.displayTitle || session.defaultName || "";
  if (session.exited) {
    session.tab.title = `${titleBase} · 已退出`;
  } else {
    session.tab.title = `${titleBase} · ${activityStateLabel(state)}`;
  }

  if (
    options.notify &&
    state === SESSION_ACTIVITY.done &&
    previousState === SESSION_ACTIVITY.running
  ) {
    notifySessionTaskDone(session);
  }
  if (session.id === activeId) {
    updateStatusBar();
  }
}

/**
 * PTY 有输出：标记为执行中（黄），并启动静默完成计时。
 * @param {any} session
 * @param {number} [byteLength]
 */
function markSessionOutput(session, byteLength = 0) {
  if (!session || session.exited) return;
  const bytes = Math.max(0, Number(byteLength) || 0);
  session.lastActivityAt = Date.now();
  session.outputByteCount = (session.outputByteCount || 0) + bytes;
  if (session.activityState !== SESSION_ACTIVITY.running) {
    session.runningSince = Date.now();
  }
  session.doneNotified = false;
  applySessionActivityState(session, SESSION_ACTIVITY.running);

  clearSessionActivityTimer(session.id);
  const timer = setTimeout(() => {
    activityIdleTimers.delete(session.id);
    if (!sessions.has(session.id) || session.exited) return;
    if (session.activityState !== SESSION_ACTIVITY.running) return;

    const enoughOutput =
      (session.outputByteCount || 0) >= MIN_OUTPUT_BYTES_FOR_DONE;
    if (enoughOutput) {
      // 本轮有足够输出后静默 → 完成（绿）
      session.outputByteCount = 0;
      applySessionActivityState(session, SESSION_ACTIVITY.done, {
        notify: true,
      });
    } else {
      // 噪声级输出（如提示符）→ 回到空闲
      session.outputByteCount = 0;
      applySessionActivityState(session, SESSION_ACTIVITY.idle);
    }
  }, TASK_DONE_IDLE_MS);
  activityIdleTimers.set(session.id, timer);
}

/**
 * 用户提交输入（回车/粘贴）后：从「完成」回到空闲，等待下一轮输出。
 * @param {any} session
 * @param {string} data
 */
function noteUserSessionInput(session, data) {
  if (!session || session.exited) return;
  const text = String(data ?? "");
  const isSubmit =
    text.includes("\r") || text.includes("\n") || text.length > 12;
  if (!isSubmit) return;
  clearSessionActivityTimer(session.id);
  session.outputByteCount = 0;
  session.doneNotified = false;
  if (session.activityState === SESSION_ACTIVITY.done) {
    applySessionActivityState(session, SESSION_ACTIVITY.idle);
  }
}

function clearSessionActivity(sessionId) {
  clearSessionActivityTimer(sessionId);
  const session = sessions.get(sessionId);
  if (session) {
    session.tab?.classList.remove(
      "state-idle",
      "state-running",
      "state-done",
      "busy"
    );
  }
}

async function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch (_) {
    return false;
  }
}

function shouldSuppressSessionNotify(session) {
  if (!session) return true;
  // 正在看该会话且窗口有焦点时不打扰
  if (session.id === activeId && document.hasFocus()) return true;
  return false;
}

async function notifySessionExited(session) {
  if (!notifyOnExit || !session) return;
  if (shouldSuppressSessionNotify(session)) return;
  const allowed = await ensureNotificationPermission();
  if (!allowed) return;
  try {
    const title = session.displayTitle || session.defaultName || "会话";
    const body = `${KIND_LABEL[session.kind] || session.kind} 已退出`;
    const notification = new Notification(title, {
      body,
      tag: `ai-terminal-exit-${session.id}`,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      activate(session.id);
      notification.close();
    };
  } catch (err) {
    console.debug("系统通知失败:", err);
  }
}

async function notifySessionTaskDone(session) {
  if (!notifyOnTaskDone || !session || session.exited) return;
  if (session.doneNotified) return;
  if (shouldSuppressSessionNotify(session)) return;
  session.doneNotified = true;
  const allowed = await ensureNotificationPermission();
  if (!allowed) return;
  try {
    const title = session.displayTitle || session.defaultName || "会话";
    const body = `${KIND_LABEL[session.kind] || session.kind} · 本轮输出已静默（可能已完成）`;
    const notification = new Notification(title, {
      body,
      tag: `ai-terminal-done-${session.id}`,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      activate(session.id);
      notification.close();
    };
  } catch (err) {
    console.debug("任务完成通知失败:", err);
  }
}

// ---------------------------------------------------------------------------
// 确认对话框
// ---------------------------------------------------------------------------
function askConfirm(message) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmMessage.textContent = message;
    confirmModal.hidden = false;
    confirmOk.focus();
  });
}

function closeConfirm(result) {
  confirmModal.hidden = true;
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(result);
  }
}

confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmModal.querySelectorAll("[data-close='confirm']").forEach((el) => {
  el.addEventListener("click", () => closeConfirm(false));
});

// ---------------------------------------------------------------------------
// 目录侧栏
// ---------------------------------------------------------------------------
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
  updateStatusBar();
}

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

function makeDirItem(dir, options = {}) {
  const item = document.createElement("div");
  item.className = "sb-recent-item";
  if (dir === defaultDir) item.classList.add("is-default");
  if (options.pinned) item.classList.add("is-pinned");
  if (dir === currentDir) item.classList.add("active");
  item.title = dir;
  item.dataset.dir = dir;

  const name = document.createElement("span");
  name.className = "ri-name";
  name.textContent = baseName(dir);
  const pathEl = document.createElement("span");
  pathEl.className = "ri-path";
  pathEl.textContent = dir;

  const actions = document.createElement("div");
  actions.className = "ri-actions";

  const pinBtn = document.createElement("button");
  pinBtn.className = "ri-action";
  pinBtn.title = options.pinned ? "取消钉住" : "钉住";
  pinBtn.textContent = options.pinned ? "★" : "☆";
  pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const cfg = await invoke("toggle_pin_dir", { dir });
      applyConfig(cfg);
    } catch (err) {
      console.error(err);
    }
  });

  const revealBtn = document.createElement("button");
  revealBtn.className = "ri-action";
  revealBtn.title = "在 Finder 中显示";
  revealBtn.textContent = "↗";
  revealBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await invoke("reveal_in_finder", { path: dir });
    } catch (err) {
      console.error(err);
    }
  });

  if (!options.pinned) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "ri-action";
    removeBtn.title = "从最近移除";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const cfg = await invoke("remove_recent_dir", { dir });
        applyConfig(cfg);
      } catch (err) {
        console.error(err);
      }
    });
    actions.append(pinBtn, revealBtn, removeBtn);
  } else {
    actions.append(pinBtn, revealBtn);
  }

  item.append(name, pathEl, actions);
  item.addEventListener("click", () => {
    currentDir = dir;
    renderCurrent();
    highlightActiveRecent();
  });
  return item;
}

function renderPinned() {
  pinnedListEl.innerHTML = "";
  const matched = pinnedDirs.filter((dir) => dirMatchesFilter(dir));
  if (!pinnedDirs.length) {
    const empty = document.createElement("div");
    empty.className = "sb-recent-empty";
    empty.textContent = "暂无钉住";
    pinnedListEl.appendChild(empty);
    return;
  }
  if (!matched.length) {
    const empty = document.createElement("div");
    empty.className = "sb-recent-empty";
    empty.textContent = "无匹配钉住";
    pinnedListEl.appendChild(empty);
    return;
  }
  for (const dir of matched) {
    pinnedListEl.appendChild(makeDirItem(dir, { pinned: true }));
  }
}

function renderRecent() {
  recentListEl.innerHTML = "";
  const filtered = recentDirs
    .filter((dir) => !pinnedDirs.includes(dir))
    .filter((dir) => dirMatchesFilter(dir));
  if (!recentDirs.filter((dir) => !pinnedDirs.includes(dir)).length) {
    const empty = document.createElement("div");
    empty.className = "sb-recent-empty";
    empty.textContent = "暂无记录";
    recentListEl.appendChild(empty);
    return;
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "sb-recent-empty";
    empty.textContent = "无匹配最近";
    recentListEl.appendChild(empty);
    return;
  }
  for (const dir of filtered) {
    recentListEl.appendChild(makeDirItem(dir, { pinned: false }));
  }
}

function focusDirFilter() {
  if (sidebarEl.classList.contains("collapsed")) {
    applySidebarCollapsed(false);
    invoke("update_prefs", { patch: { sidebarCollapsed: false } }).catch(() => {});
  }
  if (!dirFilterInput) return;
  dirFilterInput.focus();
  dirFilterInput.select();
}

function getFirstMatchedDir() {
  const pinnedMatched = pinnedDirs.filter((dir) => dirMatchesFilter(dir));
  if (pinnedMatched.length) return pinnedMatched[0];
  const recentMatched = recentDirs
    .filter((dir) => !pinnedDirs.includes(dir))
    .filter((dir) => dirMatchesFilter(dir));
  return recentMatched[0] || null;
}

function highlightActiveRecent() {
  for (const el of document.querySelectorAll(".sb-recent-item")) {
    el.classList.toggle("active", el.dataset.dir === currentDir);
  }
}

function applyConfig(cfg) {
  if (!cfg) return;
  appConfig = cfg;
  defaultDir = cfg.defaultDir || null;
  recentDirs = cfg.recentDirs || [];
  pinnedDirs = cfg.pinnedDirs || [];
  fontSize = cfg.fontSize || 13;
  lastKind = cfg.lastKind || "codex";
  copyOnSelect = cfg.copyOnSelect !== false;
  applyUiTheme(cfg.uiTheme || DEFAULT_UI_THEME, { persist: false });
  renderDefault();
  renderPinned();
  renderRecent();
  highlightActiveRecent();
  statusFont.textContent = `${fontSize}px`;
  applySidebarCollapsed(!!cfg.sidebarCollapsed);
  updateCopyOnSelectUi();
  for (const session of sessions.values()) {
    session.term.options.fontSize = fontSize;
    session.term.options.fontFamily = TERM_FONT_FAMILY;
    session.term.options.theme = getTermTheme();
    fit(session);
  }
}

function applySidebarCollapsed(collapsed) {
  sidebarEl.classList.toggle("collapsed", collapsed);
  sidebarExpandBtn.hidden = !collapsed;
}

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

async function applyAsDefault() {
  if (!currentDir) {
    pickDirBtn.classList.add("shake");
    setTimeout(() => pickDirBtn.classList.remove("shake"), 400);
    return;
  }
  try {
    const cfg = await invoke("set_default_dir", { dir: currentDir });
    applyConfig(cfg);
  } catch (err) {
    console.error("设置默认目录失败:", err);
  }
}

async function clearRecent() {
  const ok = await askConfirm("清空最近使用目录列表？");
  if (!ok) return;
  try {
    const cfg = await invoke("clear_recent_dirs");
    applyConfig(cfg);
  } catch (err) {
    console.error(err);
  }
}

async function toggleSidebar() {
  const collapsed = !sidebarEl.classList.contains("collapsed");
  applySidebarCollapsed(collapsed);
  try {
    const cfg = await invoke("update_prefs", { patch: { sidebarCollapsed: collapsed } });
    applyConfig(cfg);
  } catch (err) {
    console.error(err);
  }
  const session = sessions.get(activeId);
  if (session) requestAnimationFrame(() => fit(session));
  if (splitId) {
    const splitSession = sessions.get(splitId);
    if (splitSession) requestAnimationFrame(() => fit(splitSession));
  }
}

// ---------------------------------------------------------------------------
// 状态栏 + Git 分支
// ---------------------------------------------------------------------------
async function refreshGitBranch(pathValue) {
  const requestToken = ++gitBranchRequestToken;
  const cacheKey = pathValue || "";
  if (gitBranchCache.has(cacheKey)) {
    const cached = gitBranchCache.get(cacheKey);
    if (requestToken === gitBranchRequestToken) {
      applyBranchToStatus(cached);
    }
    return;
  }
  try {
    const branch = await invoke("get_git_branch", { path: pathValue || null });
    gitBranchCache.set(cacheKey, branch || null);
    // 缓存短时有效：目录切换/切会话时再查
    setTimeout(() => gitBranchCache.delete(cacheKey), 30_000);
    if (requestToken === gitBranchRequestToken) {
      applyBranchToStatus(branch || null);
    }
  } catch (_) {
    if (requestToken === gitBranchRequestToken) {
      applyBranchToStatus(null);
    }
  }
}

function applyBranchToStatus(branch) {
  if (branch) {
    statusBranch.textContent = `⎇ ${branch}`;
    statusBranch.title = branch;
    statusBranch.classList.remove("muted");
  } else {
    statusBranch.textContent = "—";
    statusBranch.title = "非 Git 仓库或无法读取分支";
    statusBranch.classList.add("muted");
  }
}

function updateStatusBar() {
  const session = sessions.get(activeId);
  const cwdValue = session?.cwd || currentDir || null;
  statusCwd.textContent = cwdValue || "~";
  statusCwd.title = statusCwd.textContent;
  if (session) {
    statusKind.textContent = KIND_LABEL[session.kind] || session.kind;
    if (session.exited) {
      statusState.textContent = "已退出";
      statusState.classList.add("muted");
      statusState.classList.remove("state-running", "state-done");
    } else {
      const activity = session.activityState || SESSION_ACTIVITY.idle;
      statusState.textContent = activityStateLabel(activity);
      statusState.classList.toggle("muted", activity === SESSION_ACTIVITY.idle);
      statusState.classList.toggle(
        "state-running",
        activity === SESSION_ACTIVITY.running
      );
      statusState.classList.toggle(
        "state-done",
        activity === SESSION_ACTIVITY.done
      );
    }
    statusSize.textContent = `${session.term.cols}×${session.term.rows}`;
  } else {
    statusKind.textContent = "—";
    statusState.textContent = "就绪";
    statusState.classList.add("muted");
    statusState.classList.remove("state-running", "state-done");
    statusSize.textContent = "—";
  }
  statusFont.textContent = `${fontSize}px`;
  refreshGitBranch(cwdValue);
}

// ---------------------------------------------------------------------------
// 选择即复制 + 右键菜单
// ---------------------------------------------------------------------------
function updateCopyOnSelectUi() {
  if (ctxCopyOnSelectBtn) {
    ctxCopyOnSelectBtn.textContent = `选择即复制：${copyOnSelect ? "开" : "关"}`;
  }
  const prefCheckbox = document.getElementById("pref-copy-on-select");
  if (prefCheckbox) prefCheckbox.checked = copyOnSelect;
}

async function setCopyOnSelect(enabled) {
  copyOnSelect = !!enabled;
  updateCopyOnSelectUi();
  try {
    const cfg = await invoke("update_prefs", { patch: { copyOnSelect } });
    applyConfig(cfg);
  } catch (err) {
    console.error(err);
  }
}

async function copyTextToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // 回退：临时 textarea
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      console.error(err);
    }
    area.remove();
  }
}

async function pasteIntoSession(session) {
  if (!session || session.exited) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      noteUserSessionInput(session, text);
      await invoke("write_session", { id: session.id, data: text });
    }
  } catch (err) {
    console.error("粘贴失败:", err);
  }
}

function hideContextMenu() {
  if (termContextMenu) termContextMenu.hidden = true;
  contextMenuSessionId = null;
}

function showContextMenu(session, clientX, clientY) {
  if (!termContextMenu) return;
  hideTabContextMenu();
  contextMenuSessionId = session.id;
  updateCopyOnSelectUi();
  termContextMenu.hidden = false;
  const menuWidth = termContextMenu.offsetWidth || 160;
  const menuHeight = termContextMenu.offsetHeight || 220;
  const left = Math.min(clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(clientY, window.innerHeight - menuHeight - 8);
  termContextMenu.style.left = `${Math.max(4, left)}px`;
  termContextMenu.style.top = `${Math.max(4, top)}px`;
}

function attachTerminalInteractions(session) {
  const { term, pane } = session;

  term.onSelectionChange(() => {
    if (!copyOnSelect) return;
    const selected = term.getSelection();
    if (selected && selected.length > 0) {
      copyTextToClipboard(selected);
    }
  });

  pane.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    activate(session.id);
    showContextMenu(session, event.clientX, event.clientY);
  });

  // 中键粘贴（X11 / 部分 mac 外接鼠标习惯）
  pane.addEventListener("auxclick", async (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    activate(session.id);
    await pasteIntoSession(session);
  });
}

/**
 * 原生终端常见快捷键补齐：
 * - ⌘K：清屏（不关进程）
 * - ⌘L：清屏（常见 shell 习惯）
 * - ⌘C：有选区则复制；无选区则交给终端（Ctrl-C 由 xterm 自己处理）
 * - ⌘V：粘贴
 */
function attachNativeTerminalKeys(session) {
  const { term, pane } = session;
  const onKeyDown = async (event) => {
    if (session.id !== activeId) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();

    // 清屏：⌘K / ⌘L（保留进程，只清滚动缓冲 + 发 form feed）
    if ((key === "k" || key === "l") && !event.shiftKey && event.metaKey) {
      // ⌘K 已被命令面板占用；仅当焦点在终端内且未开面板时清屏
      if (key === "k" && !commandPalette.hidden) return;
      // 用 meta+shift+k 清屏，避免与命令面板冲突；⌘L 直接清屏
      if (key === "k") return;
      event.preventDefault();
      event.stopPropagation();
      term.clear();
      // 可选：发送 clear 命令更彻底
      if (!session.exited) {
        invoke("write_session", { id: session.id, data: "\u000c" }).catch(() => {});
      }
      return;
    }

    if (key === "c" && event.metaKey && !event.shiftKey) {
      const selected = term.getSelection();
      if (selected) {
        event.preventDefault();
        await copyTextToClipboard(selected);
      }
      // 无选区时不拦截，让 Ctrl/Cmd 行为保持给 xterm（mac 上 cmd+c 无选区通常无动作）
      return;
    }

    if (key === "v" && event.metaKey && !event.shiftKey) {
      // 让默认 paste 走 xterm textarea；若失败则手动读剪贴板
      // 多数情况下 xterm 会自己处理，这里做兜底
      setTimeout(async () => {
        // no-op: 依赖 xterm 内置 paste
      }, 0);
    }
  };

  pane.addEventListener("keydown", onKeyDown, true);
  session.nativeKeyHandler = onKeyDown;
}

if (termContextMenu) {
  termContextMenu.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const session = sessions.get(contextMenuSessionId) || sessions.get(activeId);
    hideContextMenu();
    if (!session && action !== "toggle-copy-on-select") return;

    switch (action) {
      case "copy": {
        const selected = session.term.getSelection();
        if (selected) await copyTextToClipboard(selected);
        break;
      }
      case "paste":
        await pasteIntoSession(session);
        break;
      case "select-all":
        session.term.selectAll();
        break;
      case "clear":
        session.term.clear();
        break;
      case "search":
        activate(session.id);
        openSearch();
        break;
      case "export":
        activate(session.id);
        exportActiveLog();
        break;
      case "restart":
        await restartSession(session);
        break;
      case "duplicate":
        duplicateSession(session);
        break;
      case "toggle-copy-on-select":
        await setCopyOnSelect(!copyOnSelect);
        break;
      default:
        break;
    }
    session?.term.focus();
  });
}

document.addEventListener("click", (event) => {
  if (!termContextMenu || termContextMenu.hidden) return;
  if (termContextMenu.contains(event.target)) return;
  hideContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && termContextMenu && !termContextMenu.hidden) {
    hideContextMenu();
  }
});

// ---------------------------------------------------------------------------
// IME
// ---------------------------------------------------------------------------
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

/**
 * 中文输入法切到「英文/大写」态时，Shift+/ 问号等标点在 WebView + xterm 中常丢失：
 * - keyCode=229 被 CompositionHelper 吞掉，textarea 又无变化
 * - 或 key 为 Process / Unidentified，evaluateKeyboardEvent 得不到字符
 * 在捕获阶段 + attachCustomKeyEventHandler 双重兜底，直接写入 PTY。
 */
function resolveImeFallbackCharacter(event) {
  if (!event) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  // 正在拼中文候选时不要硬插标点
  if (event.isComposing) return null;
  const key = event.key;
  if (key && key.length === 1 && key !== "\u0000") return key;
  // key 为 Process/Unidentified 时，用 code + shift 还原（尤其 Slash → ?）
  const code = event.code || "";
  const shifted = !!event.shiftKey;
  const codeMap = {
    Slash: shifted ? "?" : "/",
    Period: shifted ? ">" : ".",
    Comma: shifted ? "<" : ",",
    Semicolon: shifted ? ":" : ";",
    Quote: shifted ? '"' : "'",
    BracketLeft: shifted ? "{" : "[",
    BracketRight: shifted ? "}" : "]",
    Backslash: shifted ? "|" : "\\",
    Minus: shifted ? "_" : "-",
    Equal: shifted ? "+" : "=",
    Backquote: shifted ? "~" : "`",
    Digit1: shifted ? "!" : "1",
    Digit2: shifted ? "@" : "2",
    Digit3: shifted ? "#" : "3",
    Digit4: shifted ? "$" : "4",
    Digit5: shifted ? "%" : "5",
    Digit6: shifted ? "^" : "6",
    Digit7: shifted ? "&" : "7",
    Digit8: shifted ? "*" : "8",
    Digit9: shifted ? "(" : "9",
    Digit0: shifted ? ")" : "0",
  };
  if (codeMap[code]) return codeMap[code];
  // 无 code 时用 keyCode 191 兜底 Slash
  if (event.keyCode === 191 || event.which === 191) {
    return shifted ? "?" : "/";
  }
  return null;
}

function shouldForceImePrintable(event) {
  if (!event || event.type !== "keydown") return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.isComposing) return false;
  const keyCode = event.keyCode || event.which || 0;
  if (keyCode === 229) return true;
  if (event.key === "Process" || event.key === "Unidentified") return true;
  // 少数 WebView：Slash 无 key、无 229，但 code 是 Slash 且 shift
  if (
    (event.code === "Slash" || keyCode === 191) &&
    (!event.key || event.key.length !== 1)
  ) {
    return true;
  }
  return false;
}

function writeForcedSessionCharacter(session, character) {
  if (!session || session.exited || !character) return false;
  // 同一按键可能同时命中 customKeyHandler 与 capture，短窗口去重
  const now = Date.now();
  if (
    session._lastForcedChar === character &&
    now - (session._lastForcedAt || 0) < 40
  ) {
    return false;
  }
  session._lastForcedChar = character;
  session._lastForcedAt = now;
  const textarea = session.term?.textarea;
  try {
    if (textarea) textarea.value = "";
  } catch (_) {
    /* ignore */
  }
  noteUserSessionInput(session, character);
  invoke("write_session", { id: session.id, data: character }).catch(console.error);
  return true;
}

function attachImePunctuationFix(session) {
  const { term } = session;
  const textarea = term.textarea;
  if (!textarea) return;

  const handleForcedPrintable = (event) => {
    if (session.exited) return false;
    if (!shouldForceImePrintable(event)) return false;
    const character = resolveImeFallbackCharacter(event);
    if (!character) return false;
    writeForcedSessionCharacter(session, character);
    return true;
  };

  const onKeyDownCapture = (event) => {
    if (!handleForcedPrintable(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  textarea.addEventListener("keydown", onKeyDownCapture, true);
  session.imePunctuationHandler = onKeyDownCapture;

  // xterm 内部 keydown 也会走 custom handler；返回 false 阻止其默认处理
  try {
    term.attachCustomKeyEventHandler((event) => {
      if (handleForcedPrintable(event)) return false;
      return true;
    });
  } catch (_) {
    /* older xterm */
  }
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
    textarea.addEventListener("compositionupdate", sync, true);
    textarea.addEventListener("compositionend", sync, true);
    disposers.push({
      dispose() {
        textarea.removeEventListener("focus", sync);
        textarea.removeEventListener("keydown", syncSoon, true);
        textarea.removeEventListener("compositionstart", sync, true);
        textarea.removeEventListener("compositionupdate", sync, true);
        textarea.removeEventListener("compositionend", sync, true);
      },
    });
  }
  attachImePunctuationFix(session);
  session.imeDisposers = disposers;
  sync();
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------
function updateEmptyHint() {
  emptyHint.classList.toggle("hidden", sessions.size > 0);
}

function setTitle(session, text) {
  const max = 32;
  const shown = text.length > max ? text.slice(0, max) + "…" : text;
  session.titleEl.textContent = shown;
  session.displayTitle = text;
  if (session.exited) {
    session.tab.title = `${text} · 已退出`;
  } else {
    const activity = session.activityState || SESSION_ACTIVITY.idle;
    session.tab.title = `${text} · ${activityStateLabel(activity)}`;
  }
  if (session.id === activeId) {
    document.title = `${shown} — AI Terminal`;
  }
}

function fit(session) {
  try {
    session.fitAddon.fit();
    syncImeTextarea(session);
    const { cols, rows } = session.term;
    invoke("resize_session", { id: session.id, cols, rows }).catch(() => {});
    if (session.id === activeId) updateStatusBar();
  } catch (_) {
    /* 隐藏面板 fit 可能抛错 */
  }
}

function clearSplitClasses() {
  for (const session of sessions.values()) {
    session.pane.classList.remove("split-left", "split-right");
  }
}

function applySplitLayout() {
  clearSplitClasses();
  if (!splitId || !sessions.has(splitId) || !activeId || activeId === splitId) {
    splitId = null;
    for (const session of sessions.values()) {
      session.pane.classList.toggle("active", session.id === activeId);
    }
    return;
  }
  const left = sessions.get(activeId);
  const right = sessions.get(splitId);
  if (!left || !right) {
    splitId = null;
    return;
  }
  for (const session of sessions.values()) {
    session.pane.classList.remove("active");
  }
  left.pane.classList.add("split-left");
  right.pane.classList.add("split-right");
  requestAnimationFrame(() => {
    fit(left);
    fit(right);
  });
}

function activate(id) {
  if (!sessions.has(id)) return;
  if (activeId === id && !splitId) {
    sessions.get(id)?.term.focus();
    return;
  }
  activeId = id;
  if (splitId === id) {
    // 若点到分屏右侧，把右侧升为主会话
    splitId = null;
  }
  applySplitLayout();
  if (!splitId) {
    for (const [sessionId, session] of sessions) {
      const on = sessionId === id;
      session.pane.classList.toggle("active", on);
      session.tab.classList.toggle("active", on);
    }
  } else {
    for (const [sessionId, session] of sessions) {
      session.tab.classList.toggle("active", sessionId === id || sessionId === splitId);
    }
  }
  const session = sessions.get(id);
  if (session) {
    requestAnimationFrame(() => {
      fit(session);
      if (splitId) {
        const other = sessions.get(splitId);
        if (other) fit(other);
      }
      session.term.focus();
      document.title = `${session.titleEl.textContent} — AI Terminal`;
      updateStatusBar();
    });
  }
}

async function persistSessionsSnapshot() {
  if (!appConfig?.restoreOnStartup) return;
  const restoreSessions = tabOrder
    .map((id) => sessions.get(id))
    .filter(Boolean)
    .map((session) => ({
      kind: session.kind,
      cwd: session.cwd || null,
      title: session.displayTitle || session.defaultName,
      // 再次启动时用 CLI resume 拉回对话上下文（shell 无）
      resumeMode:
        session.kind === "shell"
          ? null
          : session.resumeMode === "picker"
            ? "picker"
            : "last",
    }));
  try {
    const cfg = await invoke("update_prefs", { patch: { restoreSessions } });
    appConfig = cfg;
  } catch (err) {
    console.error(err);
  }
}

/** 续聊：恢复该工具在当前目录的最近一次会话 */
async function resumeLastSession(kind = lastKind || "codex", options = {}) {
  const targetKind = kind || "codex";
  if (!supportsResume(targetKind)) {
    await newSession(targetKind, options);
    return;
  }
  await newSession(targetKind, {
    ...options,
    resumeMode: "last",
    title: options.title || undefined,
  });
}

/** 续聊：打开该工具的会话选择器，挑选历史会话 */
async function resumePickerSession(kind = lastKind || "codex", options = {}) {
  const targetKind = kind || "codex";
  if (!supportsResume(targetKind)) {
    await newSession(targetKind, options);
    return;
  }
  await newSession(targetKind, {
    ...options,
    resumeMode: "picker",
    title: options.title || undefined,
  });
}

async function closeSession(id, options = {}) {
  const session = sessions.get(id);
  if (!session) return;
  // 关闭会话直接终止，不弹确认（更接近原生终端关标签体验）
  void options;
  try {
    await invoke("close_session", { id });
  } catch (err) {
    console.error(err);
  }
  session.unlistenOutput?.();
  session.unlistenExit?.();
  session.imeDisposers?.forEach((disposer) => disposer.dispose?.());
  session.scrollDisposer?.dispose?.();
  if (session.term?.textarea) {
    if (session.imePunctuationHandler) {
      session.term.textarea.removeEventListener(
        "keydown",
        session.imePunctuationHandler,
        true
      );
    }
    if (session.imeInputHandler) {
      session.term.textarea.removeEventListener(
        "input",
        session.imeInputHandler,
        true
      );
    }
  }
  if (session.nativeKeyHandler) {
    session.pane.removeEventListener("keydown", session.nativeKeyHandler, true);
  }
  try {
    session.webglAddon?.dispose?.();
  } catch (_) {}
  session.term.dispose();
  session.pane.remove();
  session.tab.remove();
  sessions.delete(id);
  tabOrder = tabOrder.filter((item) => item !== id);
  if (splitId === id) splitId = null;
  clearSessionActivity(id);
  session.tab.classList.remove("busy");

  if (activeId === id) {
    activeId = null;
    const next = tabOrder[tabOrder.length - 1] || null;
    if (next) activate(next);
    else {
      document.title = "AI Terminal";
      updateStatusBar();
    }
  } else {
    applySplitLayout();
  }
  updateEmptyHint();
  persistSessionsSnapshot();
}

function beginRenameTab(session) {
  if (session.titleEl.tagName === "INPUT") return;
  const input = document.createElement("input");
  input.className = "tab-title-input";
  input.value = session.displayTitle || session.defaultName;
  const finish = (commit) => {
    const value = input.value.trim();
    input.replaceWith(session.titleEl);
    if (commit && value) {
      session.customTitle = value;
      setTitle(session, value);
      persistSessionsSnapshot();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  session.titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function attachScrollToBottom(session) {
  const button = document.createElement("button");
  button.className = "scroll-bottom-btn";
  button.textContent = "↓ 底部";
  button.addEventListener("click", () => {
    session.term.scrollToBottom();
    button.classList.remove("visible");
  });
  session.pane.appendChild(button);
  session.scrollBottomBtn = button;
  session.scrollDisposer = session.term.onScroll(() => {
    const buffer = session.term.buffer.active;
    const atBottom = buffer.viewportY >= buffer.baseY;
    button.classList.toggle("visible", !atBottom);
  });
}

function setupTabDrag(session) {
  const tab = session.tab;
  // 默认不可拖：WebKit/Tauri 下 draggable=true 会吞掉 contextmenu，导致标签右键无菜单
  tab.draggable = false;
  tab.addEventListener("mousedown", (event) => {
    // 仅左键开始允许拖拽；右键/中键保持可弹出菜单
    tab.draggable = event.button === 0;
  });
  tab.addEventListener("mouseup", () => {
    tab.draggable = false;
  });
  tab.addEventListener("mouseleave", () => {
    if (!dragTabId) tab.draggable = false;
  });
  tab.addEventListener("dragstart", (event) => {
    if (event.button != null && event.button !== 0) {
      event.preventDefault();
      return;
    }
    dragTabId = session.id;
    tab.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  tab.addEventListener("dragend", () => {
    dragTabId = null;
    tab.draggable = false;
    tab.classList.remove("dragging");
  });
  tab.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!dragTabId || dragTabId === session.id) return;
    const fromIndex = tabOrder.indexOf(dragTabId);
    const toIndex = tabOrder.indexOf(session.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    tabOrder.splice(fromIndex, 1);
    tabOrder.splice(toIndex, 0, dragTabId);
    for (const id of tabOrder) {
      const item = sessions.get(id);
      if (item) tabsEl.appendChild(item.tab);
    }
  });
}


// ---------------------------------------------------------------------------
// 标签右键：关闭 / 关左侧 / 关右侧 / 关其他 / 关全部
// ---------------------------------------------------------------------------
function hideTabContextMenu() {
  if (tabContextMenu) {
    tabContextMenu.hidden = true;
    tabContextMenu.style.display = "";
    tabContextMenu.style.visibility = "";
  }
  tabContextSessionId = null;
}

function showTabContextMenu(session, clientX, clientY) {
  if (!tabContextMenu || !session) {
    console.warn("[ai-terminal] tab context menu unavailable", {
      hasMenu: !!tabContextMenu,
      hasSession: !!session,
    });
    return;
  }
  hideContextMenu();
  tabContextSessionId = session.id;
  const index = tabOrder.indexOf(session.id);
  const total = tabOrder.length;
  const setDisabled = (action, disabled) => {
    const button = tabContextMenu.querySelector(`button[data-tab-action="${action}"]`);
    if (!button) return;
    button.disabled = !!disabled;
    button.classList.toggle("disabled", !!disabled);
  };
  setDisabled("close", false);
  setDisabled("close-left", index <= 0);
  setDisabled("close-right", index < 0 || index >= total - 1);
  setDisabled("close-others", total <= 1);
  setDisabled("close-all", total === 0);

  // 先显示再量宽高，避免 hidden 时 offsetWidth 为 0 定位不准
  tabContextMenu.hidden = false;
  tabContextMenu.removeAttribute("hidden");
  tabContextMenu.style.visibility = "hidden";
  tabContextMenu.style.display = "flex";
  const menuWidth = tabContextMenu.offsetWidth || 200;
  const menuHeight = tabContextMenu.offsetHeight || 200;
  const left = Math.min(clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(clientY, window.innerHeight - menuHeight - 8);
  tabContextMenu.style.left = `${Math.max(4, left)}px`;
  tabContextMenu.style.top = `${Math.max(4, top)}px`;
  tabContextMenu.style.visibility = "visible";
  // 忽略随后紧跟的 click / pointerup，否则菜单一闪就关
  suppressDocumentClickUntil = Date.now() + 400;
}

/**
 * 从事件目标解析标签会话（支持点在 title/dot/close 子节点上）
 * @param {EventTarget|null} target
 */
function sessionFromTabEventTarget(target) {
  if (!(target instanceof Element)) return null;
  const tabEl = target.closest(".tab");
  if (!tabEl) return null;
  const sessionId = tabEl.dataset.id;
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

function openTabContextMenuFromEvent(event) {
  const session = sessionFromTabEventTarget(event.target);
  if (!session) return false;
  event.preventDefault();
  event.stopPropagation();
  // 右键时关掉拖拽，避免 WebKit 把手势当成 drag
  session.tab.draggable = false;
  activate(session.id);
  showTabContextMenu(session, event.clientX, event.clientY);
  return true;
}

function attachTabContextMenu(session) {
  // 单标签兜底；主路径见 tabsEl 事件委托
  session.tab.addEventListener("contextmenu", (event) => {
    openTabContextMenuFromEvent(event);
  });
  // 部分 WebView 对 draggable 节点不发 contextmenu：用右键 mousedown 兜底
  session.tab.addEventListener("mousedown", (event) => {
    if (event.button !== 2) return;
    openTabContextMenuFromEvent(event);
  });
}

async function closeSessionsByIds(ids) {
  const uniqueIds = [...new Set(ids)].filter((id) => sessions.has(id));
  for (const id of uniqueIds) {
    await closeSession(id, { force: true });
  }
}

async function closeOtherSessions(keepId) {
  if (!keepId || !sessions.has(keepId)) return;
  const targets = tabOrder.filter((id) => id !== keepId);
  await closeSessionsByIds(targets);
  if (sessions.has(keepId)) activate(keepId);
}

async function closeSessionsToLeft(sessionId) {
  const index = tabOrder.indexOf(sessionId);
  if (index <= 0) return;
  await closeSessionsByIds(tabOrder.slice(0, index));
  if (sessions.has(sessionId)) activate(sessionId);
}

async function closeSessionsToRight(sessionId) {
  const index = tabOrder.indexOf(sessionId);
  if (index < 0 || index >= tabOrder.length - 1) return;
  await closeSessionsByIds(tabOrder.slice(index + 1));
  if (sessions.has(sessionId)) activate(sessionId);
}

async function closeAllSessions() {
  await closeSessionsByIds([...tabOrder]);
}


/**
 * 各 AI CLI 的续聊启动命令。
 * - last：直接恢复该目录最近一次会话（历史消息由 CLI 自己加载）
 * - picker：打开 CLI 自带的会话选择器
 * 终端滚动缓冲无法跨进程恢复；真正可「接着调用」的是 CLI session store。
 */
function buildResumeLaunchCommand(kind, mode = "last", sessionId = null) {
  const resumeMode = mode === "picker" ? "picker" : "last";
  const explicitId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (explicitId) {
    switch (kind) {
      case "codex":
        return `codex resume ${explicitId}`;
      case "kiro":
        return `kiro-cli chat --resume-id ${explicitId}`;
      case "claude":
        return `claude --resume ${explicitId}`;
      case "mimo":
        return `mimo --session ${explicitId} --trust --never-ask`;
      default:
        return null;
    }
  }
  switch (kind) {
    case "codex":
      return resumeMode === "picker" ? "codex resume" : "codex resume --last";
    case "kiro":
      // 顶层 kiro-cli 也支持 --resume / --resume-picker
      return resumeMode === "picker"
        ? "kiro-cli --resume-picker"
        : "kiro-cli --resume";
    case "claude":
      // Claude Code：--continue 最近会话；--resume 交互选择
      return resumeMode === "picker" ? "claude --resume" : "claude --continue";
    case "mimo":
      // MiMo：--continue 最近；picker 无官方交互器，仍进 TUI 由用户 /session 选择
      return resumeMode === "picker"
        ? "mimo --trust --never-ask"
        : "mimo --continue --trust --never-ask";
    default:
      return null;
  }
}

function supportsResume(kind) {
  return Boolean(buildResumeLaunchCommand(kind, "last"));
}

/**
 * @param {string} kind
 * @param {{ cwd?: string|null, title?: string, resumeMode?: 'last'|'picker'|null, launchCommand?: string|null }} options
 */
async function newSession(kind, options = {}) {
  const cwd = options.cwd !== undefined ? options.cwd : currentDir;
  const id = uid();
  const resumeMode =
    options.resumeMode === "last" || options.resumeMode === "picker"
      ? options.resumeMode
      : null;
  const launchCommand =
    options.launchCommand ||
    (resumeMode ? buildResumeLaunchCommand(kind, resumeMode) : null);
  const defaultName =
    options.title ||
    (resumeMode
      ? `${defaultSessionTitle(kind, cwd)} · 续聊`
      : defaultSessionTitle(kind, cwd));

  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.dataset.id = id;
  terminalsEl.appendChild(pane);

  const tab = document.createElement("div");
  tab.className = `tab kind-${kind}`;
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="tab-dot"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="关闭">×</span>`;
  const titleEl = tab.querySelector(".tab-title");
  tabsEl.appendChild(tab);

  const term = new Terminal({
    // —— 观感：尽量贴近 macOS Terminal ——
    fontFamily: TERM_FONT_FAMILY,
    fontSize,
    fontWeight: "400",
    fontWeightBold: "700",
    lineHeight: 1.15,
    letterSpacing: 0,
    theme: getTermTheme(),
    // —— 光标 / 选择 ——
    cursorBlink: true,
    cursorStyle: "block",
    cursorWidth: 1,
    // —— 行为：对齐原生终端 ——
    allowProposedApi: true,
    allowTransparency: false,
    convertEol: false,
    disableStdin: false,
    drawBoldTextInBrightColors: true,
    // Option 作 Meta（zsh/bash 快捷键、alt 组合键）
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    // 滚动与缓冲
    scrollback: 50000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    // 对比度：避免灰底灰字
    minimumContrastRatio: 4.5,
    // 窗口尺寸变化时自动 reflow（更像真终端）
    windowsPty: undefined,
    screenReaderMode: false,
    overviewRulerWidth: 0,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const unicode11Addon = new Unicode11Addon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(searchAddon);
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = "11";
  term.open(pane);

  // WebGL 渲染：更清晰、彩色更准、滚动更流畅（失败则回退 canvas）
  let webglAddon = null;
  try {
    webglAddon = new WebglAddon();
    webglAddon.onContextLoss?.(() => {
      try {
        webglAddon.dispose();
      } catch (_) {}
      webglAddon = null;
    });
    term.loadAddon(webglAddon);
  } catch (err) {
    console.warn("WebGL 渲染不可用，回退默认渲染:", err);
    webglAddon = null;
  }

  const session = {
    id,
    kind,
    cwd: cwd || null,
    term,
    fitAddon,
    searchAddon,
    webglAddon,
    pane,
    tab,
    titleEl,
    defaultName,
    customTitle: options.title || "",
    displayTitle: defaultName,
    /** @type {'last'|'picker'|null} 下次启动是否用 CLI resume */
    resumeMode,
    launchCommand: launchCommand || null,
    exited: false,
    activityState: SESSION_ACTIVITY.idle,
    outputByteCount: 0,
    lastActivityAt: 0,
    runningSince: 0,
    doneNotified: false,
  };
  sessions.set(id, session);
  tabOrder.push(id);
  setTitle(session, defaultName);
  applySessionActivityState(session, SESSION_ACTIVITY.idle);
  attachImeTextareaSync(session);
  attachScrollToBottom(session);
  attachTerminalInteractions(session);
  attachNativeTerminalKeys(session);
  setupTabDrag(session);
  attachTabContextMenu(session);

  // 二进制安全：按字节写回 PTY（与原生终端一致，支持控制序列）
  term.onData((data) => {
    if (session.exited) return;
    noteUserSessionInput(session, data);
    invoke("write_session", { id, data }).catch(console.error);
  });

  // 二进制剪贴板粘贴已在右键菜单处理；⌘V 走浏览器默认到 textarea 再 onData

  tab.addEventListener("click", (event) => {
    if (event.target.classList.contains("tab-close")) return;
    activate(id);
  });
  tab.addEventListener("dblclick", (event) => {
    if (event.target.classList.contains("tab-close")) return;
    beginRenameTab(session);
  });
  tab.querySelector(".tab-close").addEventListener("click", (event) => {
    event.stopPropagation();
    closeSession(id);
  });

  session.unlistenOutput = await listen(`pty://output/${id}`, (event) => {
    const payload = event.payload;
    let byteLength = 0;
    if (payload instanceof Array) {
      byteLength = payload.length;
      term.write(new Uint8Array(payload));
    } else if (typeof payload === "string") {
      byteLength = payload.length;
      term.write(payload);
    }
    markSessionOutput(session, byteLength);
  });
  session.unlistenExit = await listen(`pty://exit/${id}`, () => {
    session.exited = true;
    tab.classList.add("exited");
    clearSessionActivity(id);
    applySessionActivityState(session, SESSION_ACTIVITY.idle);
    term.write("\r\n\x1b[90m[进程已退出 · 右键/⌘⇧R 重启 · 或命令面板重启]\x1b[0m\r\n");
    updateStatusBar();
    notifySessionExited(session);
  });

  updateEmptyHint();
  activate(id);

  lastKind = kind;
  invoke("update_prefs", { patch: { lastKind: kind } }).catch(() => {});

  requestAnimationFrame(async () => {
    fit(session);
    const { cols, rows } = term;
    try {
      await invoke("create_session", {
        id,
        kind,
        cols,
        rows,
        cwd: cwd || null,
        launchCommand: launchCommand || null,
      });
      if (resumeMode) {
        term.write(
          `\x1b[90m[续聊] 已注入：${launchCommand}（历史由 CLI 加载，非终端滚动缓冲）\x1b[0m\r\n`
        );
      }
      // 刷新最近目录
      try {
        const cfg = await invoke("get_app_config");
        applyConfig(cfg);
      } catch (_) {}
    } catch (err) {
      session.exited = true;
      tab.classList.add("exited");
      term.write(`\r\n\x1b[31m创建会话失败\x1b[0m\r\n`);
      term.write(`\x1b[33m${String(err)}\x1b[0m\r\n`);
      term.write(`\r\n提示：\r\n`);
      term.write(`  · 检查 CLI 是否安装：设置 → 通用 → 重新检测\r\n`);
      term.write(`  · 可在设置中修改启动命令，或关闭「自动启动 AI」后用 + Shell\r\n`);
      term.write(`  · 工作目录是否存在\r\n`);
      if (resumeMode) {
        term.write(`  · 续聊失败时可在 CLI 内手动执行：${launchCommand}\r\n`);
      }
      updateStatusBar();
    }
    term.focus();
    persistSessionsSnapshot();
  });
}

async function restartSession(session) {
  if (!session) return;
  const kind = session.kind;
  const cwd = session.cwd;
  const title = session.customTitle || session.displayTitle;
  const resumeMode = session.resumeMode || null;
  const wasSplitPartner = splitId === session.id;
  const wasActive = activeId === session.id;
  await closeSession(session.id, { force: true });
  await newSession(kind, { cwd, title, resumeMode });
  if (wasSplitPartner || wasActive) {
    /* newSession 会 activate 新会话 */
  }
}

function duplicateSession(session) {
  if (!session) return;
  newSession(session.kind, { cwd: session.cwd });
}

function toggleSplitWithNext() {
  if (!activeId) return;
  if (splitId) {
    splitId = null;
    applySplitLayout();
    activate(activeId);
    return;
  }
  const index = tabOrder.indexOf(activeId);
  const other = tabOrder[index + 1] || tabOrder[index - 1];
  if (!other) return;
  splitId = other;
  applySplitLayout();
  updateStatusBar();
}

// ---------------------------------------------------------------------------
// 字号
// ---------------------------------------------------------------------------
async function changeFontSize(delta) {
  const next = Math.min(28, Math.max(10, fontSize + delta));
  if (next === fontSize) return;
  fontSize = next;
  for (const session of sessions.values()) {
    session.term.options.fontSize = fontSize;
    fit(session);
  }
  statusFont.textContent = `${fontSize}px`;
  try {
    const cfg = await invoke("update_prefs", { patch: { fontSize } });
    applyConfig(cfg);
  } catch (err) {
    console.error(err);
  }
}

async function resetFontSize() {
  fontSize = 13;
  for (const session of sessions.values()) {
    session.term.options.fontSize = fontSize;
    fit(session);
  }
  statusFont.textContent = `${fontSize}px`;
  try {
    const cfg = await invoke("update_prefs", { patch: { fontSize } });
    applyConfig(cfg);
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
function openSearch() {
  if (!activeId) return;
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.hidden = true;
  const session = sessions.get(activeId);
  session?.searchAddon?.clearDecorations?.();
  session?.term.focus();
}

function runSearch(direction) {
  const session = sessions.get(activeId);
  if (!session) return;
  const query = searchInput.value;
  if (!query) return;
  if (direction === "prev") {
    session.searchAddon.findPrevious(query);
  } else {
    session.searchAddon.findNext(query);
  }
}

searchNext.addEventListener("click", () => runSearch("next"));
searchPrev.addEventListener("click", () => runSearch("prev"));
searchClose.addEventListener("click", closeSearch);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch(event.shiftKey ? "prev" : "next");
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function openSettings(pane = "ai") {
  settingsModal.hidden = false;
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.pane === pane);
  });
  document.querySelectorAll(".settings-pane").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.pane === pane);
  });
  loadAiConfig(currentAiTool);
  fillLaunchForm();
  fillGeneralForm();
  renderThemeGrid();
  renderProfiles();
  refreshCliStatus();
}

function closeSettings() {
  settingsModal.hidden = true;
}

document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => openSettings(tab.dataset.pane));
});
settingsModal.querySelectorAll("[data-close='settings']").forEach((el) => {
  el.addEventListener("click", closeSettings);
});
openSettingsBtn.addEventListener("click", () => openSettings("ai"));

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

document.querySelectorAll("#settings-ai-tabs .ai-tool-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#settings-ai-tabs .ai-tool-tab").forEach((item) => {
      item.classList.remove("active");
    });
    tab.classList.add("active");
    currentAiTool = tab.dataset.tool;
    loadAiConfig(currentAiTool);
  });
});

toggleApiKeyBtn.addEventListener("click", () => {
  const isPassword = aiApiKey.type === "password";
  aiApiKey.type = isPassword ? "text" : "password";
  toggleApiKeyBtn.textContent = isPassword ? "🙈" : "👁";
});

aiApplyBtn.addEventListener("click", async () => {
  const baseUrl = aiBaseUrl.value.trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    aiConfigStatus.textContent = "Base URL 须以 http:// 或 https:// 开头";
    aiConfigStatus.className = "ai-config-status error";
    return;
  }
  try {
    await invoke("write_ai_config", {
      tool: currentAiTool,
      config: {
        baseUrl,
        apiKey: aiApiKey.value.trim(),
        model: aiModel.value.trim(),
      },
    });
    aiConfigStatus.textContent = "已保存（新开会话生效）";
    aiConfigStatus.className = "ai-config-status success";
  } catch (err) {
    aiConfigStatus.textContent = `保存失败: ${err}`;
    aiConfigStatus.className = "ai-config-status error";
  }
});

aiTestBtn.addEventListener("click", async () => {
  const baseUrl = aiBaseUrl.value.trim();
  aiConfigStatus.textContent = "探测中…";
  aiConfigStatus.className = "ai-config-status";
  try {
    const result = await invoke("test_connectivity", { baseUrl });
    aiConfigStatus.textContent = result.message;
    aiConfigStatus.className = result.ok
      ? "ai-config-status success"
      : "ai-config-status error";
  } catch (err) {
    aiConfigStatus.textContent = String(err);
    aiConfigStatus.className = "ai-config-status error";
  }
});

function fillLaunchForm() {
  const launch = appConfig?.launchArgs || {};
  document.getElementById("pref-auto-launch").checked = appConfig?.autoLaunch !== false;
  document.getElementById("pref-launch-delay").value = appConfig?.launchDelayMs ?? 400;
  document.getElementById("launch-kiro").value = launch.kiro || "kiro-cli";
  document.getElementById("launch-codex").value = launch.codex || "codex";
  document.getElementById("launch-claude").value =
    launch.claude || "claude --permission-mode bypassPermissions --tools default";
  document.getElementById("launch-mimo").value =
    launch.mimo || "mimo --trust --never-ask";
}

document.getElementById("save-launch-btn").addEventListener("click", async () => {
  const status = document.getElementById("launch-status");
  try {
    const cfg = await invoke("update_prefs", {
      patch: {
        autoLaunch: document.getElementById("pref-auto-launch").checked,
        launchDelayMs: Number(document.getElementById("pref-launch-delay").value) || 400,
        launchArgs: {
          kiro: document.getElementById("launch-kiro").value.trim() || "kiro-cli",
          codex: document.getElementById("launch-codex").value.trim() || "codex",
          claude: document.getElementById("launch-claude").value.trim() || "claude",
          mimo: document.getElementById("launch-mimo").value.trim() || "mimo",
        },
      },
    });
    applyConfig(cfg);
    status.textContent = "已保存";
    status.className = "ai-config-status success";
  } catch (err) {
    status.textContent = String(err);
    status.className = "ai-config-status error";
  }
});

function fillGeneralForm() {
  document.getElementById("pref-font-size").value = fontSize;
  document.getElementById("pref-restore").checked = !!appConfig?.restoreOnStartup;
  document.getElementById("pref-copy-on-select").checked = copyOnSelect;
  const notifyExitCheckbox = document.getElementById("pref-notify-exit");
  if (notifyExitCheckbox) notifyExitCheckbox.checked = notifyOnExit;
  const notifyDoneCheckbox = document.getElementById("pref-notify-task-done");
  if (notifyDoneCheckbox) notifyDoneCheckbox.checked = notifyOnTaskDone;
}

document.getElementById("save-general-btn").addEventListener("click", async () => {
  const status = document.getElementById("general-status");
  const nextFont = Number(document.getElementById("pref-font-size").value) || 13;
  const notifyExitCheckbox = document.getElementById("pref-notify-exit");
  if (notifyExitCheckbox) {
    saveNotifyOnExitPref(notifyExitCheckbox.checked);
  }
  const notifyDoneCheckbox = document.getElementById("pref-notify-task-done");
  if (notifyDoneCheckbox) {
    saveNotifyOnTaskDonePref(notifyDoneCheckbox.checked);
  }
  if (notifyOnExit || notifyOnTaskDone) {
    ensureNotificationPermission().catch(() => {});
  }
  try {
    const cfg = await invoke("update_prefs", {
      patch: {
        fontSize: nextFont,
        restoreOnStartup: document.getElementById("pref-restore").checked,
        copyOnSelect: document.getElementById("pref-copy-on-select").checked,
      },
    });
    applyConfig(cfg);
    status.textContent = "已保存";
    status.className = "ai-config-status success";
  } catch (err) {
    status.textContent = String(err);
    status.className = "ai-config-status error";
  }
});

async function refreshCliStatus() {
  const list = document.getElementById("cli-status-list");
  list.innerHTML = "检测中…";
  try {
    const results = await invoke("check_all_cli");
    list.innerHTML = "";
    for (const item of results) {
      const row = document.createElement("div");
      row.className = "cli-status-row";
      const dot = document.createElement("span");
      dot.className = `cli-dot ${item.available ? "ok" : "bad"}`;
      const text = document.createElement("span");
      text.textContent = `${KIND_LABEL[item.kind] || item.kind}: ${item.command} — ${
        item.available ? item.path : item.message
      }`;
      row.append(dot, text);
      list.appendChild(row);
    }
  } catch (err) {
    list.textContent = String(err);
  }
}

document.getElementById("refresh-cli-btn").addEventListener("click", refreshCliStatus);

// 配置档案
function renderProfiles() {
  const list = document.getElementById("profiles-list");
  list.innerHTML = "";
  const profiles = appConfig?.profiles || [];
  if (!profiles.length) {
    list.innerHTML = '<div class="sb-recent-empty">暂无档案，可在上方创建</div>';
    return;
  }
  for (const profile of profiles) {
    const item = document.createElement("div");
    item.className = "profile-item";
    const name = document.createElement("span");
    name.className = "pi-name";
    name.textContent = profile.name;
    const meta = document.createElement("span");
    meta.className = "pi-meta";
    meta.textContent = `${profile.tool} · ${profile.model || "—"}`;
    const applyBtn = document.createElement("button");
    applyBtn.className = "sb-btn ghost";
    applyBtn.style.flex = "0 0 auto";
    applyBtn.style.height = "26px";
    applyBtn.style.padding = "0 10px";
    applyBtn.textContent = "应用";
    applyBtn.addEventListener("click", async () => {
      try {
        await invoke("write_ai_config", {
          tool: profile.tool,
          config: {
            baseUrl: profile.baseUrl || "",
            apiKey: profile.apiKey || "",
            model: profile.model || "",
          },
        });
        currentAiTool = profile.tool;
        document.querySelectorAll("#settings-ai-tabs .ai-tool-tab").forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.tool === profile.tool);
        });
        await loadAiConfig(profile.tool);
        aiConfigStatus.textContent = `已应用档案「${profile.name}」`;
        aiConfigStatus.className = "ai-config-status success";
        openSettings("ai");
      } catch (err) {
        console.error(err);
      }
    });
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "×";
    delBtn.title = "删除";
    delBtn.addEventListener("click", async () => {
      const next = (appConfig.profiles || []).filter((item) => item.id !== profile.id);
      try {
        const cfg = await invoke("update_prefs", { patch: { profiles: next } });
        applyConfig(cfg);
        renderProfiles();
      } catch (err) {
        console.error(err);
      }
    });
    item.append(name, meta, applyBtn, delBtn);
    list.appendChild(item);
  }
}

document.getElementById("profile-from-current-btn").addEventListener("click", () => {
  document.getElementById("profile-tool").value = currentAiTool;
  document.getElementById("profile-base-url").value = aiBaseUrl.value;
  document.getElementById("profile-api-key").value = aiApiKey.value;
  document.getElementById("profile-model").value = aiModel.value;
});

document.getElementById("profile-save-btn").addEventListener("click", async () => {
  const name = document.getElementById("profile-name").value.trim();
  if (!name) return;
  const profile = {
    id: uid(),
    name,
    tool: document.getElementById("profile-tool").value,
    baseUrl: document.getElementById("profile-base-url").value.trim(),
    apiKey: document.getElementById("profile-api-key").value.trim(),
    model: document.getElementById("profile-model").value.trim(),
  };
  const profiles = [...(appConfig?.profiles || []), profile];
  try {
    const cfg = await invoke("update_prefs", { patch: { profiles } });
    applyConfig(cfg);
    document.getElementById("profile-name").value = "";
    renderProfiles();
  } catch (err) {
    console.error(err);
  }
});

// ---------------------------------------------------------------------------
// 命令面板
// ---------------------------------------------------------------------------
function buildPaletteCommands() {
  const commands = [
    { id: "new-last", label: "新建会话（上次工具）", keys: "⌘T", run: () => newSession(lastKind || "codex") },
    {
      id: "resume-last",
      label: "续聊：恢复最近会话（上次工具）",
      keys: "⌘⇧T",
      run: () => resumeLastSession(lastKind || "codex"),
    },
    {
      id: "resume-picker",
      label: "续聊：打开会话选择器（上次工具）",
      keys: "⌘⌥T",
      run: () => resumePickerSession(lastKind || "codex"),
    },
    { id: "resume-codex-last", label: "续聊 Codex（最近）", keys: "", run: () => resumeLastSession("codex") },
    { id: "resume-codex-pick", label: "续聊 Codex（选择会话）", keys: "", run: () => resumePickerSession("codex") },
    { id: "resume-kiro-last", label: "续聊 Kiro（最近）", keys: "", run: () => resumeLastSession("kiro") },
    { id: "resume-kiro-pick", label: "续聊 Kiro（选择会话）", keys: "", run: () => resumePickerSession("kiro") },
    { id: "resume-claude-last", label: "续聊 Claude（最近）", keys: "", run: () => resumeLastSession("claude") },
    { id: "resume-claude-pick", label: "续聊 Claude（选择会话）", keys: "", run: () => resumePickerSession("claude") },
    { id: "resume-mimo-last", label: "续聊 MiMo（最近）", keys: "", run: () => resumeLastSession("mimo") },
    { id: "resume-mimo-pick", label: "续聊 MiMo（选择会话）", keys: "", run: () => resumePickerSession("mimo") },
    { id: "new-codex", label: "新建 Codex", keys: "", run: () => newSession("codex") },
    { id: "new-claude", label: "新建 Claude", keys: "", run: () => newSession("claude") },
    { id: "new-kiro", label: "新建 Kiro", keys: "⌘⇧K", run: () => newSession("kiro") },
    { id: "new-mimo", label: "新建 MiMo", keys: "", run: () => newSession("mimo") },
    { id: "new-shell", label: "新建 Shell", keys: "", run: () => newSession("shell") },
    { id: "close", label: "关闭当前会话", keys: "⌘W", run: () => activeId && closeSession(activeId) },
    {
      id: "close-others",
      label: "关闭其他标签",
      keys: "",
      run: () => activeId && closeOtherSessions(activeId),
    },
    {
      id: "close-all",
      label: "关闭全部标签",
      keys: "",
      run: () => closeAllSessions(),
    },
    { id: "split", label: "分屏 / 取消分屏", keys: "⌘\\", run: () => toggleSplitWithNext() },
    { id: "dup", label: "复制当前会话", keys: "", run: () => activeId && duplicateSession(sessions.get(activeId)) },
    {
      id: "restart",
      label: "重启当前会话",
      keys: "⌘⇧R",
      run: () => activeId && restartSession(sessions.get(activeId)),
    },
    { id: "filter-dir", label: "筛选项目目录", keys: "⌘P", run: () => focusDirFilter() },
    { id: "search", label: "终端搜索", keys: "⌘F", run: () => openSearch() },
    { id: "settings", label: "打开设置", keys: "⌘,", run: () => openSettings("ai") },
    { id: "themes", label: "切换界面主题", keys: "", run: () => openSettings("theme") },
    { id: "sidebar", label: "折叠/展开侧栏", keys: "⌘B", run: () => toggleSidebar() },
    { id: "pick-dir", label: "选择工作目录", keys: "", run: () => pickDirectory() },
    { id: "font-up", label: "增大字号", keys: "⌘+", run: () => changeFontSize(1) },
    { id: "font-down", label: "减小字号", keys: "⌘-", run: () => changeFontSize(-1) },
    {
      id: "export",
      label: "导出当前终端日志",
      keys: "",
      run: () => exportActiveLog(),
    },
  ];
  // 最近目录快捷入口
  for (const dir of [...pinnedDirs, ...recentDirs].slice(0, 8)) {
    commands.push({
      id: `dir-${dir}`,
      label: `切换目录: ${baseName(dir)}`,
      keys: "",
      run: () => {
        currentDir = dir;
        renderCurrent();
        highlightActiveRecent();
      },
    });
  }
  return commands;
}

function renderPalette(filter = "") {
  const query = filter.trim().toLowerCase();
  paletteCommands = buildPaletteCommands().filter((command) =>
    !query || command.label.toLowerCase().includes(query)
  );
  paletteIndex = 0;
  paletteList.innerHTML = "";
  if (!paletteCommands.length) {
    paletteList.innerHTML = '<div class="palette-empty">无匹配命令</div>';
    return;
  }
  paletteCommands.forEach((command, index) => {
    const item = document.createElement("div");
    item.className = "palette-item" + (index === 0 ? " active" : "");
    item.innerHTML = `<span>${command.label}</span><span class="pk">${command.keys || ""}</span>`;
    item.addEventListener("mouseenter", () => {
      paletteIndex = index;
      highlightPalette();
    });
    item.addEventListener("click", () => runPaletteCommand(command));
    paletteList.appendChild(item);
  });
}

function highlightPalette() {
  const items = paletteList.querySelectorAll(".palette-item");
  items.forEach((item, index) => item.classList.toggle("active", index === paletteIndex));
  items[paletteIndex]?.scrollIntoView({ block: "nearest" });
}

function runPaletteCommand(command) {
  closePalette();
  command.run();
}

function openPalette() {
  commandPalette.hidden = false;
  paletteInput.value = "";
  renderPalette("");
  paletteInput.focus();
}

function closePalette() {
  commandPalette.hidden = true;
  sessions.get(activeId)?.term.focus();
}

paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));
paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(paletteCommands.length - 1, paletteIndex + 1);
    highlightPalette();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    highlightPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const command = paletteCommands[paletteIndex];
    if (command) runPaletteCommand(command);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
});
commandPalette.querySelectorAll("[data-close='palette']").forEach((el) => {
  el.addEventListener("click", closePalette);
});
cmdPaletteBtn.addEventListener("click", openPalette);

function exportActiveLog() {
  const session = sessions.get(activeId);
  if (!session) return;
  const buffer = session.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ai-terminal-${session.kind}-${Date.now()}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------
function switchTabByOffset(offset) {
  if (!tabOrder.length) return;
  const current = Math.max(0, tabOrder.indexOf(activeId));
  const next = (current + offset + tabOrder.length) % tabOrder.length;
  activate(tabOrder[next]);
}

function switchTabByIndex(index) {
  const id = tabOrder[index];
  if (id) activate(id);
}

window.addEventListener("keydown", (event) => {
  // 模态内 Esc
  if (event.key === "Escape") {
    if (tabContextMenu && !tabContextMenu.hidden) {
      hideTabContextMenu();
      return;
    }
    if (!settingsModal.hidden) {
      closeSettings();
      return;
    }
    if (!commandPalette.hidden) {
      closePalette();
      return;
    }
    if (!confirmModal.hidden) {
      closeConfirm(false);
      return;
    }
    if (!searchBar.hidden) {
      closeSearch();
      return;
    }
  }

  if (!modKey(event)) return;
  const key = event.key.toLowerCase();
  const allowedInInput = new Set([
    "b",
    "k",
    ",",
    "t",
    "w",
    "p",
    "r",
    "f",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
  ]);
  if (isEditableTarget(event.target) && !allowedInInput.has(key) && event.key !== "Tab") {
    return;
  }

  if (key === "t" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    newSession(lastKind || "codex");
    return;
  }
  // ⌘⇧T：续聊最近会话；⌘⌥T：打开会话选择器
  if (key === "t" && event.shiftKey && !event.altKey) {
    event.preventDefault();
    resumeLastSession(lastKind || "codex");
    return;
  }
  if (key === "t" && event.altKey && !event.shiftKey) {
    event.preventDefault();
    resumePickerSession(lastKind || "codex");
    return;
  }
  if (key === "k" && event.shiftKey) {
    event.preventDefault();
    newSession("kiro");
    return;
  }
  if (key === "r" && event.shiftKey) {
    event.preventDefault();
    if (activeId) restartSession(sessions.get(activeId));
    return;
  }
  if (key === "p" && !event.shiftKey) {
    event.preventDefault();
    focusDirFilter();
    return;
  }
  if (key === "w") {
    event.preventDefault();
    if (activeId) closeSession(activeId);
    return;
  }
  if (key === "b" && !event.shiftKey) {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (key === ",") {
    event.preventDefault();
    openSettings("ai");
    return;
  }
  if (key === "k" && !event.shiftKey) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (key === "f") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (key === "\\" || event.code === "Backslash") {
    event.preventDefault();
    toggleSplitWithNext();
    return;
  }
  if (key === "=" || key === "+") {
    event.preventDefault();
    changeFontSize(1);
    return;
  }
  if (key === "-") {
    event.preventDefault();
    changeFontSize(-1);
    return;
  }
  if (key === "0") {
    event.preventDefault();
    resetFontSize();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    switchTabByOffset(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key >= "1" && event.key <= "9") {
    event.preventDefault();
    switchTabByIndex(Number(event.key) - 1);
  }
});


// 标签栏委托：比单标签监听更稳，点在 title/dot 上也能出菜单
if (tabsEl) {
  tabsEl.addEventListener(
    "contextmenu",
    (event) => {
      openTabContextMenuFromEvent(event);
    },
    true
  );
  tabsEl.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 2) return;
      openTabContextMenuFromEvent(event);
    },
    true
  );
}

if (tabContextMenu) {
  const runTabContextAction = async (action, sessionId) => {
    hideTabContextMenu();
    if (!sessionId && action !== "close-all") return;
    switch (action) {
      case "close":
        await closeSession(sessionId, { force: true });
        break;
      case "close-left":
        await closeSessionsToLeft(sessionId);
        break;
      case "close-right":
        await closeSessionsToRight(sessionId);
        break;
      case "close-others":
        await closeOtherSessions(sessionId);
        break;
      case "close-all":
        await closeAllSessions();
        break;
      default:
        break;
    }
  };

  tabContextMenu.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("button[data-tab-action]");
    if (!button || button.disabled) return;
    await runTabContextAction(button.dataset.tabAction, tabContextSessionId);
  });
  // mousedown 立刻响应，避免被 document click 抢先关掉
  tabContextMenu.addEventListener("mousedown", async (event) => {
    if (event.button !== 0) return;
    const button = event.target.closest("button[data-tab-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    await runTabContextAction(button.dataset.tabAction, tabContextSessionId);
  });
}

document.addEventListener(
  "click",
  (event) => {
    if (Date.now() < suppressDocumentClickUntil) return;
    if (!tabContextMenu || tabContextMenu.hidden) return;
    if (tabContextMenu.contains(event.target)) return;
    hideTabContextMenu();
  },
  true
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && tabContextMenu && !tabContextMenu.hidden) {
    hideTabContextMenu();
  }
});

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
pickDirBtn.addEventListener("click", pickDirectory);
setDefaultBtn.addEventListener("click", applyAsDefault);
clearRecentBtn.addEventListener("click", clearRecent);
sidebarCollapseBtn.addEventListener("click", toggleSidebar);
sidebarExpandBtn.addEventListener("click", toggleSidebar);

if (dirFilterInput) {
  dirFilterInput.addEventListener("input", () => {
    dirFilterQuery = dirFilterInput.value || "";
    renderPinned();
    renderRecent();
    highlightActiveRecent();
  });
  dirFilterInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const matchedDir = getFirstMatchedDir();
      if (matchedDir) {
        currentDir = matchedDir;
        renderCurrent();
        highlightActiveRecent();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      dirFilterInput.value = "";
      dirFilterQuery = "";
      renderPinned();
      renderRecent();
      highlightActiveRecent();
      dirFilterInput.blur();
    }
  });
}

document.querySelectorAll(".new-btn[data-kind]").forEach((btn) => {
  btn.addEventListener("click", () => newSession(btn.dataset.kind));
});
document.querySelectorAll(".empty-card").forEach((btn) => {
  btn.addEventListener("click", () => newSession(btn.dataset.kind));
});
document.getElementById("resume-last-btn")?.addEventListener("click", () => {
  resumeLastSession(lastKind || "codex");
});
document.getElementById("resume-picker-btn")?.addEventListener("click", () => {
  resumePickerSession(lastKind || "codex");
});

window.addEventListener("resize", () => {
  const session = sessions.get(activeId);
  if (session) fit(session);
  if (splitId) {
    const other = sessions.get(splitId);
    if (other) fit(other);
  }
});

// 拖拽文件夹到窗口
window.addEventListener("dragover", (event) => {
  event.preventDefault();
});
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  // Tauri 桌面端文件路径可能不可用；优先 dialog
});

window.addEventListener("beforeunload", () => {
  invoke("close_all_sessions").catch(() => {});
  persistSessionsSnapshot();
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  updateEmptyHint();
  notifyOnExit = loadNotifyOnExitPref();
  notifyOnTaskDone = loadNotifyOnTaskDonePref();
  try {
    const cfg = await invoke("get_app_config");
    applyConfig(cfg);
    currentDir = defaultDir;
    renderCurrent();
    highlightActiveRecent();

    if (cfg.restoreOnStartup && Array.isArray(cfg.restoreSessions) && cfg.restoreSessions.length) {
      for (const snapshot of cfg.restoreSessions) {
        const kind = snapshot.kind || "shell";
        let resumeMode = null;
        if (kind !== "shell") {
          if (snapshot.resumeMode === "picker") resumeMode = "picker";
          else resumeMode = "last"; // 含旧快照无 resumeMode
        }
        await newSession(kind, {
          cwd: snapshot.cwd || null,
          title: snapshot.title || "",
          resumeMode,
        });
      }
    }
  } catch (err) {
    console.error("读取配置失败:", err);
  }
}

init();
