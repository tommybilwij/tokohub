use std::collections::HashMap;
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

struct SidecarState {
    child: Option<Child>,
}

/// Read ~/.stock-entry/.envrc and parse `export KEY=value` lines into a HashMap.
fn load_envrc() -> HashMap<String, String> {
    let mut envs = HashMap::new();
    let envrc_path = dirs::home_dir()
        .map(|h| h.join(".stock-entry").join(".envrc"));
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
                    envs.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
            log::info!("Loaded {} env vars from {:?}", envs.len(), path);
        } else {
            log::warn!("No .envrc found at {:?}", path);
        }
    }
    envs
}

fn spawn_sidecar(app: &tauri::App) {
    // The sidecar lives in Contents/Resources/binaries/ (not Contents/MacOS/)
    // to avoid PyInstaller's .app bundle path detection breaking things.
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to get resource dir");

    let sidecar_path = resource_dir.join("binaries").join("stock-entry-server");

    log::info!("Spawning sidecar: {:?}", sidecar_path);

    if !sidecar_path.exists() {
        log::error!("Sidecar not found at {:?}", sidecar_path);
        return;
    }

    // Load env vars from ~/.stock-entry/.envrc and pass to sidecar
    let envrc_vars = load_envrc();

    let child = match Command::new(&sidecar_path)
        .args(["--port", &PORT.to_string(), "--host", "127.0.0.1"])
        .envs(&envrc_vars)
        .stdout(std::fs::File::create("/tmp/stock-entry-sidecar.log").unwrap())
        .stderr(std::fs::File::create("/tmp/stock-entry-sidecar.err").unwrap())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            log::error!("Failed to spawn sidecar: {}", e);
            return;
        }
    };

    log::info!("Sidecar started (pid {})", child.id());

    let state = app.state::<Mutex<SidecarState>>();
    let mut s = state.lock().unwrap();
    s.child = Some(child);
}

fn poll_health_and_show(app_handle: tauri::AppHandle) {
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

            // Try HTTP first (frozen/PyInstaller), then HTTPS (dev with SSL)
            // Try HTTP first (sidecar default), then HTTPS as fallback
            let urls = [(HEALTH_URL_HTTP, APP_URL_HTTP), (HEALTH_URL_HTTPS, APP_URL_HTTPS)];
            for (health_url, app_url) in urls {
                match client.get(health_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        log::info!("Flask is ready on {}, showing window", health_url);
                        if let Some(webview) = app_handle.get_webview_window("main") {
                            // Navigate to the app URL now that Flask is ready
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
        .manage(Mutex::new(SidecarState { child: None }))
        .setup(|app| {
            spawn_sidecar(app);
            poll_health_and_show(app.handle().clone());
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
