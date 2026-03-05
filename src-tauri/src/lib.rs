use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri::RunEvent;
use tauri::Url;

const PORT: u16 = 5000;
const HEALTH_URL_HTTP: &str = "http://127.0.0.1:5000/health";
const HEALTH_URL_HTTPS: &str = "https://127.0.0.1:5000/health";
const APP_URL_HTTP: &str = "http://127.0.0.1:5000";
const APP_URL_HTTPS: &str = "https://127.0.0.1:5000";
const HEALTH_POLL_MS: u64 = 500;
const HEALTH_TIMEOUT_S: u64 = 30;
const MONITOR_INTERVAL_S: u64 = 3;

struct SidecarState {
    child: Option<Child>,
    sidecar_path: PathBuf,
}

/// Read ~/.tokohub/.envrc and parse `export KEY=value` lines into a HashMap.
fn load_envrc() -> HashMap<String, String> {
    let mut envs = HashMap::new();
    let envrc_path = dirs::home_dir()
        .map(|h| h.join(".tokohub").join(".envrc"));
    if let Some(path) = envrc_path {
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                // Strip optional "export " prefix
                let kv = trimmed.strip_prefix("export ").unwrap_or(trimmed);
                if let Some((key, value)) = kv.split_once('=') {
                    let v = value.trim();
                    let v = v.strip_prefix('"').unwrap_or(v);
                    let v = v.strip_suffix('"').unwrap_or(v);
                    envs.insert(key.trim().to_string(), v.to_string());
                }
            }
            log::info!("Loaded {} env vars from {:?}", envs.len(), path);
        } else {
            log::warn!("No .envrc found at {:?}", path);
        }
    }
    envs
}

/// Spawn the sidecar process and return the Child handle.
/// Return ~/.tokohub/logs/, creating it if needed.
fn log_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .expect("no home dir")
        .join(".tokohub")
        .join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn do_spawn(sidecar_path: &PathBuf) -> Option<Child> {
    let envrc_vars = load_envrc();
    let logs = log_dir();

    match Command::new(sidecar_path)
        .args(["--port", &PORT.to_string(), "--host", "127.0.0.1"])
        .envs(&envrc_vars)
        .stdout(
            std::fs::File::options()
                .append(true)
                .create(true)
                .open(logs.join("sidecar.log"))
                .expect("failed to open sidecar log"),
        )
        .stderr(
            std::fs::File::options()
                .append(true)
                .create(true)
                .open(logs.join("sidecar.err"))
                .expect("failed to open sidecar err log"),
        )
        .spawn()
    {
        Ok(child) => {
            log::info!("Sidecar started (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            log::error!("Failed to spawn sidecar: {}", e);
            None
        }
    }
}

fn spawn_sidecar(app: &tauri::App) {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to get resource dir");

    let sidecar_name = if cfg!(target_os = "windows") {
        "tokohub-server.exe"
    } else {
        "tokohub-server"
    };
    let sidecar_path = resource_dir.join("binaries").join(sidecar_name);

    log::info!("Spawning sidecar: {:?}", sidecar_path);

    if !sidecar_path.exists() {
        log::error!("Sidecar not found at {:?}", sidecar_path);
        return;
    }

    let child = do_spawn(&sidecar_path);

    let state = app.state::<Mutex<SidecarState>>();
    let mut s = state.lock().unwrap();
    s.child = child;
    s.sidecar_path = sidecar_path;
}

fn poll_health_and_navigate(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .expect("failed to build HTTP client");
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_S);

        loop {
            if tokio::time::Instant::now() > deadline {
                log::error!("Flask health check timed out after {}s", HEALTH_TIMEOUT_S);
                break;
            }

            let urls = [(HEALTH_URL_HTTP, APP_URL_HTTP), (HEALTH_URL_HTTPS, APP_URL_HTTPS)];
            for (health_url, app_url) in urls {
                match client.get(health_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        log::info!("Flask is ready on {}, navigating window", health_url);
                        if let Some(webview) = app_handle.get_webview_window("main") {
                            let _ = webview.navigate(Url::parse(app_url).unwrap());
                            let _ = webview.show();
                        }
                        return;
                    }
                    _ => {}
                }
            }

            tokio::time::sleep(Duration::from_millis(HEALTH_POLL_MS)).await;
        }
    });
}

/// Background monitor: detect sidecar death and auto-respawn.
fn monitor_sidecar(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait for initial startup before monitoring
        tokio::time::sleep(Duration::from_secs(HEALTH_TIMEOUT_S)).await;

        loop {
            tokio::time::sleep(Duration::from_secs(MONITOR_INTERVAL_S)).await;

            let needs_respawn = {
                let state = app_handle.state::<Mutex<SidecarState>>();
                let mut s = state.lock().unwrap();
                match s.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            log::warn!("Sidecar exited ({}), will respawn", status);
                            s.child = None;
                            true
                        }
                        Ok(None) => false, // still running
                        Err(e) => {
                            log::error!("Error checking sidecar: {}", e);
                            false
                        }
                    },
                    None => true,
                }
            };

            if needs_respawn {
                // Wait for port to be released by the OS
                tokio::time::sleep(Duration::from_secs(1)).await;

                let sidecar_path = {
                    let state = app_handle.state::<Mutex<SidecarState>>();
                    let s = state.lock().unwrap();
                    s.sidecar_path.clone()
                };

                if sidecar_path.as_os_str().is_empty() {
                    log::error!("No sidecar path stored, cannot respawn");
                    continue;
                }

                log::info!("Respawning sidecar...");
                if let Some(child) = do_spawn(&sidecar_path) {
                    {
                        let state = app_handle.state::<Mutex<SidecarState>>();
                        let mut s = state.lock().unwrap();
                        s.child = Some(child);
                    }
                    poll_health_and_navigate(app_handle.clone());
                }
            }
        }
    });
}

fn kill_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<SidecarState>>();
    let mut s = state.lock().unwrap();
    if let Some(mut child) = s.child.take() {
        log::info!("Killing Flask sidecar (pid {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .manage(Mutex::new(SidecarState {
            child: None,
            sidecar_path: PathBuf::new(),
        }))
        .setup(|app| {
            spawn_sidecar(app);
            let handle = app.handle().clone();
            poll_health_and_navigate(handle.clone());
            monitor_sidecar(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_sidecar(app_handle);
            }
            _ => {}
        });
}
