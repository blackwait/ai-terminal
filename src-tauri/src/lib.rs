// AI Terminal 后端：基于 portable-pty 的多会话终端管理
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

/// 单个 PTY 会话持有的资源
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// 工作目录配置（默认目录 + 最近使用列表），持久化到磁盘
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirConfig {
    /// 默认工作目录；为空表示使用用户主目录
    #[serde(default)]
    default_dir: Option<String>,
    /// 最近使用过的目录（最新在前）
    #[serde(default)]
    recent_dirs: Vec<String>,
}

/// 全局会话表 + 目录配置
#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    config: Arc<Mutex<DirConfig>>,
}

const RECENT_LIMIT: usize = 10;

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

/// 配置文件路径：<app_config_dir>/dir-config.json
fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("dir-config.json"))
}

/// 从磁盘读取配置，失败时返回默认配置
fn load_config(app: &AppHandle) -> DirConfig {
    if let Some(path) = config_file(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<DirConfig>(&text) {
                return cfg;
            }
        }
    }
    DirConfig::default()
}

/// 把配置写入磁盘
fn save_config(app: &AppHandle, cfg: &DirConfig) -> Result<(), String> {
    let path = config_file(app).ok_or("无法定位配置目录")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

/// 把目录插入到最近列表头部（去重 + 截断）
fn push_recent(cfg: &mut DirConfig, dir: &str) {
    cfg.recent_dirs.retain(|d| d != dir);
    cfg.recent_dirs.insert(0, dir.to_string());
    cfg.recent_dirs.truncate(RECENT_LIMIT);
}

/// 读取当前目录配置
#[tauri::command]
fn get_dir_config(state: State<AppState>) -> DirConfig {
    state.config.lock().clone()
}

/// 设置默认工作目录，并加入最近列表
#[tauri::command]
fn set_default_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<DirConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        cfg.default_dir = Some(dir.clone());
        push_recent(&mut cfg, &dir);
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

/// 记录一个最近使用的目录
#[tauri::command]
fn add_recent_dir(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
) -> Result<DirConfig, String> {
    let snapshot = {
        let mut cfg = state.config.lock();
        push_recent(&mut cfg, &dir);
        cfg.clone()
    };
    save_config(&app, &snapshot)?;
    Ok(snapshot)
}

/// 新建会话：启动用户默认 shell 的交互式登录终端，并按会话类型自动拉起对应 AI CLI
#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    kind: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // 使用当前平台可启动的默认 shell，保留完整的交互式终端能力
    let (shell, shell_args) = shell_command();
    let mut cmd = CommandBuilder::new(&shell);
    for arg in shell_args {
        cmd.arg(arg);
    }

    // 工作目录：优先使用前端传入的 cwd，其次用户主目录
    let work_dir = cwd.filter(|d| !d.trim().is_empty()).or_else(user_home_dir);
    if let Some(dir) = work_dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()),
    );

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave 端在子进程接管后即可释放
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // 读线程：把 PTY 输出以原始字节推送到前端，避免拆分多字节字符乱码
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

    // 根据会话类型自动启动对应 AI CLI
    let launch = match kind.as_str() {
        "kiro" => Some("kiro-cli\r"),
        "codex" => Some("codex\r"),
        "claude" => Some("claude --permission-mode bypassPermissions --tools default\r"),
        "mimo" => Some("mimo --trust --never-ask\r"),
        _ => None,
    };
    if let Some(line) = launch {
        if let Some(sess) = state.sessions.lock().get_mut(&id) {
            let _ = sess.writer.write_all(line.as_bytes());
            let _ = sess.writer.flush();
        }
    }

    Ok(())
}

/// 把前端输入写回 PTY
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

/// 调整 PTY 尺寸
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

/// 关闭并清理会话
#[tauri::command]
fn close_session(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(mut sess) = state.sessions.lock().remove(&id) {
        let _ = sess.child.kill();
    }
    Ok(())
}

/// AI 工具配置项
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiToolConfig {
    /// 基础 URL
    base_url: String,
    /// API 密钥
    api_key: String,
    /// 模型名称
    model: String,
}

/// 读取指定 AI 工具的配置
#[tauri::command]
fn read_ai_config(tool: String) -> Result<AiToolConfig, String> {
    let home = user_home_dir().ok_or("无法获取用户主目录")?;
    match tool.as_str() {
        "codex" => {
            // ~/.codex/config.toml + ~/.codex/auth.json
            let config_path = format!("{}/.codex/config.toml", home);
            let auth_path = format!("{}/.codex/auth.json", home);
            let config_text = std::fs::read_to_string(&config_path).unwrap_or_default();
            let auth_text = std::fs::read_to_string(&auth_path).unwrap_or_default();
            // 解析 TOML 中的 model 和 base_url
            let mut model = String::new();
            let mut base_url = String::new();
            for line in config_text.lines() {
                let trimmed = line.trim();
                if let Some(v) = trimmed.strip_prefix("model = ") {
                    model = v.trim_matches('"').to_string();
                }
                if let Some(v) = trimmed.strip_prefix("base_url = ") {
                    base_url = v.trim_matches('"').to_string();
                }
            }
            // 解析 auth.json 中的 OPENAI_API_KEY
            let mut api_key = String::new();
            if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&auth_text) {
                if let Some(key) = auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) {
                    api_key = key.to_string();
                }
            }
            Ok(AiToolConfig { base_url, api_key, model })
        }
        "claude" => {
            // ~/.claude/settings.json
            let settings_path = format!("{}/.claude/settings.json", home);
            let text = std::fs::read_to_string(&settings_path).unwrap_or_default();
            let mut base_url = String::new();
            let mut api_key = String::new();
            let mut model = String::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(env) = v.get("env") {
                    base_url = env.get("ANTHROPIC_BASE_URL").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    api_key = env.get("ANTHROPIC_API_KEY").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    model = env.get("ANTHROPIC_MODEL").and_then(|s| s.as_str()).unwrap_or("").to_string();
                }
            }
            Ok(AiToolConfig { base_url, api_key, model })
        }
        "mimo" => {
            // ~/.local/share/mimocode/auth.json
            let auth_path = format!("{}/.local/share/mimocode/auth.json", home);
            let text = std::fs::read_to_string(&auth_path).unwrap_or_default();
            let mut base_url = String::new();
            let mut api_key = String::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(creds) = v.get("credentials").and_then(|c| c.as_array()) {
                    if let Some(first) = creds.first() {
                        base_url = first.get("baseUrl").and_then(|s| s.as_str()).unwrap_or("").to_string();
                        api_key = first.get("apiKey").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    }
                }
            }
            // MiMo 模型从 config.toml 的 model 字段读取（如果存在）
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
            Ok(AiToolConfig { base_url, api_key, model })
        }
        _ => Err(format!("未知工具类型: {}", tool)),
    }
}

/// 写入指定 AI 工具的配置
#[tauri::command]
fn write_ai_config(tool: String, config: AiToolConfig) -> Result<(), String> {
    let home = user_home_dir().ok_or("无法获取用户主目录")?;
    match tool.as_str() {
        "codex" => {
            // 更新 ~/.codex/config.toml 中的 model 和 base_url
            let config_path = format!("{}/.codex/config.toml", home);
            let mut content = std::fs::read_to_string(&config_path).unwrap_or_default();
            content = update_toml_value(&content, "model", &config.model);
            // 更新 model_providers.custom.base_url
            content = update_toml_section_value(&content, "model_providers.custom", "base_url", &config.base_url);
            std::fs::write(&config_path, content).map_err(|e| e.to_string())?;
            // 更新 ~/.codex/auth.json
            let auth_path = format!("{}/.codex/auth.json", home);
            let auth = serde_json::json!({ "OPENAI_API_KEY": config.api_key });
            std::fs::write(&auth_path, serde_json::to_string_pretty(&auth).unwrap()).map_err(|e| e.to_string())?;
        }
        "claude" => {
            // 更新 ~/.claude/settings.json 中的 env 字段
            let settings_path = format!("{}/.claude/settings.json", home);
            let text = std::fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
            let mut v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
            let env = v.get_mut("env").cloned().unwrap_or(serde_json::json!({}));
            let mut env_map = env.as_object().cloned().unwrap_or_default();
            env_map.insert("ANTHROPIC_BASE_URL".into(), serde_json::Value::String(config.base_url));
            env_map.insert("ANTHROPIC_API_KEY".into(), serde_json::Value::String(config.api_key));
            env_map.insert("ANTHROPIC_MODEL".into(), serde_json::Value::String(config.model.clone()));
            env_map.insert("ANTHROPIC_SMALL_FAST_MODEL".into(), serde_json::Value::String(config.model));
            v["env"] = serde_json::Value::Object(env_map);
            std::fs::write(&settings_path, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
        }
        "mimo" => {
            // 更新 ~/.local/share/mimocode/auth.json
            let auth_path = format!("{}/.local/share/mimocode/auth.json", home);
            let auth = serde_json::json!({
                "version": 1,
                "credentials": [{
                    "provider": "custom",
                    "apiKey": config.api_key,
                    "baseUrl": config.base_url
                }]
            });
            std::fs::write(&auth_path, serde_json::to_string_pretty(&auth).unwrap()).map_err(|e| e.to_string())?;
            // 更新 ~/.mimocode/config.toml 中的 model
            if !config.model.is_empty() {
                let mimo_config_path = format!("{}/.mimocode/config.toml", home);
                let mut content = std::fs::read_to_string(&mimo_config_path).unwrap_or_default();
                if content.contains("model = ") {
                    content = update_toml_value(&content, "model", &config.model);
                } else {
                    content = format!("model = \"{}\"\n{}", config.model, content);
                }
                if let Some(parent) = std::path::Path::new(&mimo_config_path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&mimo_config_path, content).map_err(|e| e.to_string())?;
            }
        }
        _ => return Err(format!("未知工具类型: {}", tool)),
    }
    Ok(())
}

/// 更新 TOML 文件中的顶层 key = "value"
fn update_toml_value(content: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let mut found = false;
    for line in &mut lines {
        if line.trim().starts_with(&format!("{} = ", key)) {
            *line = format!("{} = \"{}\"", key, value);
            found = true;
            break;
        }
    }
    if !found {
        lines.insert(0, format!("{} = \"{}\"", key, value));
    }
    lines.join("\n")
}

/// 更新 TOML 文件中 [section] 下的 key = "value"
fn update_toml_section_value(content: &str, section: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let section_header = format!("[{}]", section);
    let mut in_section = false;
    let mut found = false;
    for line in &mut lines {
        if line.trim() == section_header {
            in_section = true;
            continue;
        }
        if in_section && line.trim().starts_with('[') {
            break;
        }
        if in_section && line.trim().starts_with(&format!("{} = ", key)) {
            *line = format!("{} = \"{}\"", key, value);
            found = true;
            break;
        }
    }
    if !found {
        // 在 section header 后面插入
        if let Some(pos) = lines.iter().position(|l| l.trim() == section_header) {
            lines.insert(pos + 1, format!("{} = \"{}\"", key, value));
        }
    }
    lines.join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // 启动时加载持久化的目录配置
            let cfg = load_config(&app.handle());
            *app.state::<AppState>().config.lock() = cfg;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_session,
            resize_session,
            close_session,
            get_dir_config,
            set_default_dir,
            add_recent_dir,
            read_ai_config,
            write_ai_config
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Terminal 失败");
}
