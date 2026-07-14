// AI Terminal 后端：基于 portable-pty 的多会话终端管理
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// 单个 PTY 会话持有的资源
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// 各 AI 工具的启动参数
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchArgs {
    #[serde(default = "default_kiro_args")]
    kiro: String,
    #[serde(default = "default_codex_args")]
    codex: String,
    #[serde(default = "default_claude_args")]
    claude: String,
    #[serde(default = "default_mimo_args")]
    mimo: String,
}

fn default_kiro_args() -> String {
    "kiro-cli".into()
}
fn default_codex_args() -> String {
    "codex".into()
}
fn default_claude_args() -> String {
    "claude --permission-mode bypassPermissions --tools default".into()
}
fn default_mimo_args() -> String {
    "mimo --trust --never-ask".into()
}

impl Default for LaunchArgs {
    fn default() -> Self {
        Self {
            kiro: default_kiro_args(),
            codex: default_codex_args(),
            claude: default_claude_args(),
            mimo: default_mimo_args(),
        }
    }
}

/// AI 配置档案
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigProfile {
    id: String,
    name: String,
    tool: String,
    base_url: String,
    api_key: String,
    model: String,
}

/// 可恢复会话快照
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshot {
    kind: String,
    cwd: Option<String>,
    title: String,
    /// 启动时续聊模式：last / picker；空表示新建会话
    #[serde(default)]
    resume_mode: Option<String>,
}

/// 应用完整配置（目录 + 偏好 + 启动参数 + 档案）
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default)]
    default_dir: Option<String>,
    #[serde(default)]
    recent_dirs: Vec<String>,
    #[serde(default)]
    pinned_dirs: Vec<String>,
    #[serde(default = "default_font_size")]
    font_size: u32,
    #[serde(default = "default_last_kind")]
    last_kind: String,
    #[serde(default)]
    launch_args: LaunchArgs,
    /// 是否自动注入 AI CLI 命令
    #[serde(default = "default_true")]
    auto_launch: bool,
    /// 注入前等待毫秒（等 shell prompt）
    #[serde(default = "default_launch_delay_ms")]
    launch_delay_ms: u64,
    #[serde(default)]
    sidebar_collapsed: bool,
    #[serde(default)]
    profiles: Vec<ConfigProfile>,
    #[serde(default)]
    restore_sessions: Vec<SessionSnapshot>,
    /// 是否在启动时恢复上次会话
    #[serde(default)]
    restore_on_startup: bool,
    /// 终端选中文本后自动复制到剪贴板
    #[serde(default = "default_true")]
    copy_on_select: bool,
    /// UI 主题 id：cyberpunk / matrix / arctic / plasma / amber / holographic
    #[serde(default = "default_ui_theme")]
    ui_theme: String,
}

fn default_font_size() -> u32 {
    13
}
fn default_last_kind() -> String {
    "codex".into()
}
fn default_true() -> bool {
    true
}
fn default_launch_delay_ms() -> u64 {
    400
}
fn default_ui_theme() -> String {
    "cyberpunk".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            default_dir: None,
            recent_dirs: Vec::new(),
            pinned_dirs: Vec::new(),
            font_size: default_font_size(),
            last_kind: default_last_kind(),
            launch_args: LaunchArgs::default(),
            auto_launch: true,
            launch_delay_ms: default_launch_delay_ms(),
            sidebar_collapsed: false,
            profiles: Vec::new(),
            restore_sessions: Vec::new(),
            restore_on_startup: false,
            copy_on_select: true,
            ui_theme: default_ui_theme(),
        }
    }
}

/// 兼容旧版仅含 defaultDir/recentDirs 的 dir-config.json
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDirConfig {
    #[serde(default)]
    default_dir: Option<String>,
    #[serde(default)]
    recent_dirs: Vec<String>,
}

/// 全局会话表 + 配置
struct AppState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    config: Arc<Mutex<AppConfig>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            config: Arc::new(Mutex::new(AppConfig::default())),
        }
    }
}

const RECENT_LIMIT: usize = 15;

#[cfg(windows)]
fn shell_command() -> (String, Vec<&'static str>) {
    let shell = std::env::var("COMSPEC")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string());
    (shell, Vec::new())
}

#[cfg(not(windows))]
fn shell_command() -> (String, Vec<&'static str>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    (shell, vec!["-l"])
}

#[cfg(windows)]
fn user_home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .or_else(|| {
            let drive = std::env::var("HOMEDRIVE").ok()?;
            let path = std::env::var("HOMEPATH").ok()?;
            let home = format!("{drive}{path}");
            (!home.trim().is_empty()).then_some(home)
        })
        .or_else(|| std::env::var("HOME").ok().filter(|d| !d.trim().is_empty()))
}

#[cfg(not(windows))]
fn user_home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|d| !d.trim().is_empty())
}

/// GUI 应用启动时常缺少用户 shell PATH，合并常见路径
fn enrich_path_env() {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(current) = std::env::var("PATH") {
        for p in current.split(':') {
            if !p.is_empty() && !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
    }
    let home = user_home_dir().unwrap_or_default();
    let extras = [
        format!("{}/.local/bin", home),
        format!("{}/.cargo/bin", home),
        format!("{}/.npm-global/bin", home),
        format!("{}/bin", home),
        "/usr/local/bin".into(),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ];
    for extra in extras {
        if !extra.is_empty() && !parts.iter().any(|x| x == &extra) {
            parts.push(extra);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("app-config.json"))
}

fn legacy_config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("dir-config.json"))
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_config(app: &AppHandle) -> AppConfig {
    if let Some(path) = config_file(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&text) {
                return cfg;
            }
        }
    }
    // 迁移旧 dir-config.json
    if let Some(path) = legacy_config_file(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(legacy) = serde_json::from_str::<LegacyDirConfig>(&text) {
                let mut cfg = AppConfig::default();
                cfg.default_dir = legacy.default_dir;
                cfg.recent_dirs = legacy.recent_dirs;
                return cfg;
            }
        }
    }
    AppConfig::default()
}

fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_file(app).ok_or("无法定位配置目录")?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    atomic_write(&path, &text)
}

fn push_recent(cfg: &mut AppConfig, dir: &str) {
    cfg.recent_dirs.retain(|d| d != dir);
    cfg.recent_dirs.insert(0, dir.to_string());
    cfg.recent_dirs.truncate(RECENT_LIMIT);
}

fn kill_all_sessions(state: &AppState) {
    let mut map = state.sessions.lock();
    for (_id, mut sess) in map.drain() {
        let _ = sess.child.kill();
    }
}

// ---------- 目录 / 配置命令 ----------

#[tauri::command]
fn get_dir_config(state: State<AppState>) -> AppConfig {
    state.config.lock().clone()
}

#[tauri::command]
fn get_app_config(state: State<AppState>) -> AppConfig {
    state.config.lock().clone()
}

/// 部分更新偏好（字号、启动参数、侧栏、恢复等）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrefsPatch {
    font_size: Option<u32>,
    last_kind: Option<String>,
    launch_args: Option<LaunchArgs>,
    auto_launch: Option<bool>,
    launch_delay_ms: Option<u64>,
    sidebar_collapsed: Option<bool>,
    restore_on_startup: Option<bool>,
    restore_sessions: Option<Vec<SessionSnapshot>>,
    profiles: Option<Vec<ConfigProfile>>,
    copy_on_select: Option<bool>,
    ui_theme: Option<String>,
}

fn normalize_ui_theme(theme: &str) -> String {
    match theme.trim().to_ascii_lowercase().as_str() {
        "cyberpunk" | "matrix" | "arctic" | "plasma" | "amber" | "holographic" => {
            theme.trim().to_ascii_lowercase()
        }
        _ => default_ui_theme(),
    }
}

#[tauri::command]
fn update_prefs(
    app: AppHandle,
    state: State<AppState>,
    patch: PrefsPatch,
) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        if let Some(v) = patch.font_size {
            cfg.font_size = v.clamp(10, 28);
        }
        if let Some(v) = patch.last_kind {
            cfg.last_kind = v;
        }
        if let Some(v) = patch.launch_args {
            cfg.launch_args = v;
        }
        if let Some(v) = patch.auto_launch {
            cfg.auto_launch = v;
        }
        if let Some(v) = patch.launch_delay_ms {
            cfg.launch_delay_ms = v.min(5000);
        }
        if let Some(v) = patch.sidebar_collapsed {
            cfg.sidebar_collapsed = v;
        }
        if let Some(v) = patch.restore_on_startup {
            cfg.restore_on_startup = v;
        }
        if let Some(v) = patch.restore_sessions {
            cfg.restore_sessions = v;
        }
        if let Some(v) = patch.profiles {
            cfg.profiles = v;
        }
        if let Some(v) = patch.copy_on_select {
            cfg.copy_on_select = v;
        }
        if let Some(v) = patch.ui_theme {
            cfg.ui_theme = normalize_ui_theme(&v);
        }
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn set_default_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        cfg.default_dir = Some(dir.clone());
        push_recent(&mut cfg, &dir);
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn add_recent_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        push_recent(&mut cfg, &dir);
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn remove_recent_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        cfg.recent_dirs.retain(|d| d != &dir);
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn clear_recent_dirs(app: AppHandle, state: State<AppState>) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        cfg.recent_dirs.clear();
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn toggle_pin_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<AppConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        if cfg.pinned_dirs.iter().any(|d| d == &dir) {
            cfg.pinned_dirs.retain(|d| d != &dir);
        } else {
            cfg.pinned_dirs.insert(0, dir);
            cfg.pinned_dirs.truncate(20);
        }
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

// ---------- CLI 健康检查 ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCheckResult {
    kind: String,
    command: String,
    available: bool,
    path: Option<String>,
    message: String,
}

fn cli_binary_for_kind(kind: &str, launch_args: &LaunchArgs) -> String {
    let line = match kind {
        "kiro" => &launch_args.kiro,
        "codex" => &launch_args.codex,
        "claude" => &launch_args.claude,
        "mimo" => &launch_args.mimo,
        _ => kind,
    };
    line.split_whitespace().next().unwrap_or(kind).to_string()
}

fn which_command(binary: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let output = Command::new("where").arg(binary).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("which").arg(binary).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Some(text.trim().to_string()).filter(|s| !s.is_empty())
    }
}

fn check_cli_with_config(cfg: &AppConfig, kind: &str) -> CliCheckResult {
    let binary = cli_binary_for_kind(kind, &cfg.launch_args);
    match which_command(&binary) {
        Some(path) => CliCheckResult {
            kind: kind.to_string(),
            command: binary,
            available: true,
            path: Some(path),
            message: "可用".into(),
        },
        None => CliCheckResult {
            kind: kind.to_string(),
            command: binary.clone(),
            available: false,
            path: None,
            message: format!(
                "未找到命令「{}」。请确认已安装并在 PATH 中（GUI 启动可能缺少 shell PATH）。",
                binary
            ),
        },
    }
}

#[tauri::command]
fn check_cli(state: State<AppState>, kind: String) -> CliCheckResult {
    let cfg = state.config.lock().clone();
    check_cli_with_config(&cfg, &kind)
}

#[tauri::command]
fn check_all_cli(state: State<AppState>) -> Vec<CliCheckResult> {
    let cfg = state.config.lock().clone();
    ["kiro", "codex", "claude", "mimo"]
        .iter()
        .map(|kind| check_cli_with_config(&cfg, kind))
        .collect()
}

// ---------- 会话 ----------

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    kind: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    // 可选：覆盖默认启动命令（用于 resume / 续聊）
    launch_command: Option<String>,
) -> Result<(), String> {
    // 校验工作目录
    if let Some(ref dir) = cwd {
        if !dir.trim().is_empty() && !Path::new(dir).is_dir() {
            return Err(format!("工作目录不存在: {}", dir));
        }
    }

    let cfg_snapshot = state.config.lock().clone();
    let launch_override = launch_command
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty());
    // 续聊会传 launch_command：即使关闭「自动启动 AI」也要注入 resume 命令
    let should_auto_inject = cfg_snapshot.auto_launch || launch_override.is_some();

    // 若需要自动注入 AI / 续聊命令，先检查 CLI 是否存在
    if should_auto_inject && kind != "shell" {
        let binary = if let Some(ref override_line) = launch_override {
            override_line
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        } else {
            cli_binary_for_kind(&kind, &cfg_snapshot.launch_args)
        };
        if !binary.is_empty() && which_command(&binary).is_none() {
            return Err(format!(
                "未找到命令「{}」。请安装对应 CLI 或在设置中修改启动命令，也可关闭「自动启动 AI」。",
                binary
            ));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let (shell, shell_args) = shell_command();
    let mut cmd = CommandBuilder::new(&shell);
    for arg in shell_args {
        cmd.arg(arg);
    }

    let work_dir = cwd
        .filter(|d| !d.trim().is_empty())
        .or_else(user_home_dir);
    if let Some(ref dir) = work_dir {
        cmd.cwd(dir);
    }

    // 与 macOS Terminal / iTerm 对齐的终端环境：真彩、UTF-8、CLI 颜色
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "AITerminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // 优先沿用系统语言环境，保证中文与 UTF-8 正常
    let locale = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "zh_CN.UTF-8".into());
    cmd.env("LANG", &locale);
    cmd.env("LC_ALL", &locale);
    cmd.env("LC_CTYPE", &locale);
    // 常见 CLI 彩色输出开关（ls / git / 多数 TUI）
    cmd.env("CLICOLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("FORCE_COLOR", "1");
    // 把当前进程 PATH（已 enrich）传给子 shell
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    // 继承常用环境，避免 shell 配置依赖缺失
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "SHELL",
        "SSH_AUTH_SOCK",
        "XPC_FLAGS",
        "XPC_SERVICE_NAME",
    ] {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let _ = app_for_reader.emit(&format!("pty://output/{id_for_reader}"), chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_for_reader.emit(&format!("pty://exit/{id_for_reader}"), ());
    });

    state.sessions.lock().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );

    // 延迟注入 AI CLI / 续聊命令，等待 login shell 就绪
    if should_auto_inject {
        let launch_line = if let Some(override_line) = launch_override {
            Some(override_line)
        } else {
            match kind.as_str() {
                "kiro" => Some(cfg_snapshot.launch_args.kiro.clone()),
                "codex" => Some(cfg_snapshot.launch_args.codex.clone()),
                "claude" => Some(cfg_snapshot.launch_args.claude.clone()),
                "mimo" => Some(cfg_snapshot.launch_args.mimo.clone()),
                "shell" => None,
                _ => None,
            }
        };
        if let Some(line) = launch_line {
            let delay = cfg_snapshot.launch_delay_ms;
            let sessions = Arc::clone(&state.sessions);
            let sid = id.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(delay));
                if let Some(sess) = sessions.lock().get_mut(&sid) {
                    let payload = format!("{}\r", line.trim());
                    let _ = sess.writer.write_all(payload.as_bytes());
                    let _ = sess.writer.flush();
                }
            });
        }
    }

    // 使用过的目录记入最近
    if let Some(dir) = work_dir {
        if Path::new(&dir).is_dir() {
            let snapshot = {
                let mut cfg = state.config.lock();
                push_recent(&mut cfg, &dir);
                cfg.clone()
            };
            let _ = save_config(&app, &snapshot);
        }
    }

    Ok(())
}

#[tauri::command]
fn write_session(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock();
    let sess = map.get_mut(&id).ok_or("会话不存在")?;
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    sess.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_session(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock();
    if let Some(sess) = map.get(&id) {
        sess.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_session(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(mut sess) = state.sessions.lock().remove(&id) {
        let _ = sess.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn close_all_sessions(state: State<AppState>) -> Result<(), String> {
    kill_all_sessions(&state);
    Ok(())
}

// ---------- AI 配置 ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiToolConfig {
    base_url: String,
    api_key: String,
    model: String,
}

#[tauri::command]
fn read_ai_config(tool: String) -> Result<AiToolConfig, String> {
    let home = user_home_dir().ok_or("无法获取用户主目录")?;
    match tool.as_str() {
        "codex" => {
            let config_path = format!("{}/.codex/config.toml", home);
            let auth_path = format!("{}/.codex/auth.json", home);
            let config_text = std::fs::read_to_string(&config_path).unwrap_or_default();
            let auth_text = std::fs::read_to_string(&auth_path).unwrap_or_default();
            let mut model = String::new();
            let mut base_url = String::new();
            let mut in_custom = false;
            for line in config_text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') {
                    in_custom = trimmed == "[model_providers.custom]";
                    continue;
                }
                if let Some(v) = trimmed.strip_prefix("model = ") {
                    if !in_custom {
                        model = v.trim_matches('"').to_string();
                    }
                }
                if let Some(v) = trimmed.strip_prefix("base_url = ") {
                    base_url = v.trim_matches('"').to_string();
                }
            }
            let mut api_key = String::new();
            if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&auth_text) {
                if let Some(key) = auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) {
                    api_key = key.to_string();
                }
            }
            Ok(AiToolConfig {
                base_url,
                api_key,
                model,
            })
        }
        "claude" => {
            let settings_path = format!("{}/.claude/settings.json", home);
            let text = std::fs::read_to_string(&settings_path).unwrap_or_default();
            let mut base_url = String::new();
            let mut api_key = String::new();
            let mut model = String::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(env) = v.get("env") {
                    base_url = env
                        .get("ANTHROPIC_BASE_URL")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    api_key = env
                        .get("ANTHROPIC_API_KEY")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    model = env
                        .get("ANTHROPIC_MODEL")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
            Ok(AiToolConfig {
                base_url,
                api_key,
                model,
            })
        }
        "mimo" => {
            let auth_path = format!("{}/.local/share/mimocode/auth.json", home);
            let text = std::fs::read_to_string(&auth_path).unwrap_or_default();
            let mut base_url = String::new();
            let mut api_key = String::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(creds) = v.get("credentials").and_then(|c| c.as_array()) {
                    if let Some(first) = creds.first() {
                        base_url = first
                            .get("baseUrl")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        api_key = first
                            .get("apiKey")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                }
            }
            let mimo_config_path = format!("{}/.mimocode/config.toml", home);
            let mut model = String::new();
            if let Ok(cfg_text) = std::fs::read_to_string(&mimo_config_path) {
                for line in cfg_text.lines() {
                    let trimmed = line.trim();
                    if let Some(v) = trimmed.strip_prefix("model = ") {
                        model = v.trim_matches('"').to_string();
                    }
                }
            }
            Ok(AiToolConfig {
                base_url,
                api_key,
                model,
            })
        }
        _ => Err(format!("未知工具类型: {}", tool)),
    }
}

/// 合并写入 JSON 对象中的指定 key，保留其它字段
fn merge_json_file(path: &str, mutator: impl FnOnce(&mut serde_json::Value)) -> Result<(), String> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let mut value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    if !value.is_object() {
        value = serde_json::json!({});
    }
    mutator(&mut value);
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    atomic_write(Path::new(path), &out)
}

#[tauri::command]
fn write_ai_config(tool: String, config: AiToolConfig) -> Result<(), String> {
    let home = user_home_dir().ok_or("无法获取用户主目录")?;
    match tool.as_str() {
        "codex" => {
            let config_path = format!("{}/.codex/config.toml", home);
            let mut content = std::fs::read_to_string(&config_path).unwrap_or_default();
            if !config.model.is_empty() {
                content = update_toml_value(&content, "model", &config.model);
            }
            if !config.base_url.is_empty() {
                content = update_toml_section_value(
                    &content,
                    "model_providers.custom",
                    "base_url",
                    &config.base_url,
                );
            }
            if let Some(parent) = Path::new(&config_path).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            atomic_write(Path::new(&config_path), &content)?;

            let auth_path = format!("{}/.codex/auth.json", home);
            merge_json_file(&auth_path, |v| {
                v["OPENAI_API_KEY"] = serde_json::Value::String(config.api_key.clone());
            })?;
        }
        "claude" => {
            let settings_path = format!("{}/.claude/settings.json", home);
            merge_json_file(&settings_path, |v| {
                let env = v
                    .get_mut("env")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                let mut env_map = env.as_object().cloned().unwrap_or_default();
                if !config.base_url.is_empty() {
                    env_map.insert(
                        "ANTHROPIC_BASE_URL".into(),
                        serde_json::Value::String(config.base_url.clone()),
                    );
                }
                if !config.api_key.is_empty() {
                    env_map.insert(
                        "ANTHROPIC_API_KEY".into(),
                        serde_json::Value::String(config.api_key.clone()),
                    );
                }
                if !config.model.is_empty() {
                    env_map.insert(
                        "ANTHROPIC_MODEL".into(),
                        serde_json::Value::String(config.model.clone()),
                    );
                    env_map.insert(
                        "ANTHROPIC_SMALL_FAST_MODEL".into(),
                        serde_json::Value::String(config.model.clone()),
                    );
                }
                v["env"] = serde_json::Value::Object(env_map);
            })?;
        }
        "mimo" => {
            let auth_path = format!("{}/.local/share/mimocode/auth.json", home);
            merge_json_file(&auth_path, |v| {
                if v.get("version").is_none() {
                    v["version"] = serde_json::json!(1);
                }
                let creds = v
                    .get_mut("credentials")
                    .and_then(|c| c.as_array_mut());
                if let Some(arr) = creds {
                    if let Some(first) = arr.first_mut() {
                        if !config.api_key.is_empty() {
                            first["apiKey"] =
                                serde_json::Value::String(config.api_key.clone());
                        }
                        if !config.base_url.is_empty() {
                            first["baseUrl"] =
                                serde_json::Value::String(config.base_url.clone());
                        }
                    } else {
                        arr.push(serde_json::json!({
                            "provider": "custom",
                            "apiKey": config.api_key,
                            "baseUrl": config.base_url
                        }));
                    }
                } else {
                    v["credentials"] = serde_json::json!([{
                        "provider": "custom",
                        "apiKey": config.api_key,
                        "baseUrl": config.base_url
                    }]);
                }
            })?;
            if !config.model.is_empty() {
                let mimo_config_path = format!("{}/.mimocode/config.toml", home);
                let mut content = std::fs::read_to_string(&mimo_config_path).unwrap_or_default();
                if content.contains("model = ") {
                    content = update_toml_value(&content, "model", &config.model);
                } else {
                    content = format!("model = \"{}\"\n{}", config.model, content);
                }
                if let Some(parent) = Path::new(&mimo_config_path).parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                atomic_write(Path::new(&mimo_config_path), &content)?;
            }
        }
        _ => return Err(format!("未知工具类型: {}", tool)),
    }
    Ok(())
}

/// 简单连通性探测：校验 URL 并对 base 发 HEAD/GET（不带敏感信息日志）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectivityResult {
    ok: bool,
    status: Option<u16>,
    message: String,
}

#[tauri::command]
fn test_connectivity(base_url: String) -> ConnectivityResult {
    let url = base_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return ConnectivityResult {
            ok: false,
            status: None,
            message: "Base URL 为空".into(),
        };
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return ConnectivityResult {
            ok: false,
            status: None,
            message: "Base URL 须以 http:// 或 https:// 开头".into(),
        };
    }
    // 使用 curl 做轻量探测，避免引入额外 HTTP 依赖
    let output = Command::new("curl")
        .args([
            "-sS",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--connect-timeout",
            "5",
            "--max-time",
            "10",
            "-L",
            &url,
        ])
        .output();
    match output {
        Ok(out) if out.status.success() || out.status.code() == Some(0) || !out.stdout.is_empty() => {
            let code_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let code: u16 = code_str.parse().unwrap_or(0);
            if code > 0 {
                ConnectivityResult {
                    ok: code < 500,
                    status: Some(code),
                    message: format!("HTTP {}", code),
                }
            } else {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                ConnectivityResult {
                    ok: false,
                    status: None,
                    message: if err.is_empty() {
                        "无法解析响应状态".into()
                    } else {
                        err
                    },
                }
            }
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            ConnectivityResult {
                ok: false,
                status: None,
                message: if err.is_empty() {
                    "请求失败".into()
                } else {
                    err
                },
            }
        }
        Err(e) => ConnectivityResult {
            ok: false,
            status: None,
            message: format!("无法执行 curl: {}", e),
        },
    }
}

/// 读取目录所在 git 仓库的当前分支名；非仓库返回 null
#[tauri::command]
fn get_git_branch(path: Option<String>) -> Option<String> {
    let dir = path
        .filter(|value| !value.trim().is_empty())
        .or_else(user_home_dir)?;
    if !Path::new(&dir).is_dir() {
        return None;
    }
    let output = Command::new("git")
        .args(["-C", &dir, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        // detached HEAD：尝试短 hash
        let hash_output = Command::new("git")
            .args(["-C", &dir, "rev-parse", "--short", "HEAD"])
            .output()
            .ok()?;
        if !hash_output.status.success() {
            return None;
        }
        let hash = String::from_utf8_lossy(&hash_output.stdout)
            .trim()
            .to_string();
        return if hash.is_empty() {
            None
        } else {
            Some(format!("detached@{}", hash))
        };
    }
    Some(branch)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn update_toml_value(content: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let mut found = false;
    let mut in_section = false;
    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = true;
            continue;
        }
        // 只改顶层 key（进入任意 section 前）
        if !in_section && trimmed.starts_with(&format!("{} = ", key)) {
            *line = format!("{} = \"{}\"", key, value);
            found = true;
            break;
        }
    }
    if !found {
        lines.insert(0, format!("{} = \"{}\"", key, value));
    }
    let mut out = lines.join("\n");
    if content.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn update_toml_section_value(content: &str, section: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let section_header = format!("[{}]", section);
    let mut in_section = false;
    let mut found = false;
    let mut section_pos: Option<usize> = None;
    for (idx, line) in lines.iter_mut().enumerate() {
        let trimmed = line.trim();
        if trimmed == section_header {
            in_section = true;
            section_pos = Some(idx);
            continue;
        }
        if in_section && trimmed.starts_with('[') {
            break;
        }
        if in_section && trimmed.starts_with(&format!("{} = ", key)) {
            *line = format!("{} = \"{}\"", key, value);
            found = true;
            break;
        }
    }
    if !found {
        if let Some(pos) = section_pos {
            lines.insert(pos + 1, format!("{} = \"{}\"", key, value));
        } else {
            if !lines.is_empty() && !lines.last().map(|l| l.is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
            lines.push(section_header);
            lines.push(format!("{} = \"{}\"", key, value));
        }
    }
    let mut out = lines.join("\n");
    if content.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    enrich_path_env();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let cfg = load_config(&app.handle());
            *app.state::<AppState>().config.lock() = cfg;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_session,
            resize_session,
            close_session,
            close_all_sessions,
            get_dir_config,
            get_app_config,
            update_prefs,
            set_default_dir,
            add_recent_dir,
            remove_recent_dir,
            clear_recent_dirs,
            toggle_pin_dir,
            check_cli,
            check_all_cli,
            read_ai_config,
            write_ai_config,
            test_connectivity,
            reveal_in_finder,
            get_git_branch,
        ])
        .build(tauri::generate_context!())
        .expect("构建 AI Terminal 失败");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                kill_all_sessions(&state);
            }
        }
    });
}
