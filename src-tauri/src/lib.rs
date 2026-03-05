use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri::RunEvent;

const PORT: u16 = 5000;
const HEALTH_URL: &str = "http://127.0.0.1:5000/health";
const HEALTH_POLL_MS: u64 = 500;
const HEALTH_TIMEOUT_S: u64 = 30;

struct SidecarState {
    child: Option<Child>,
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

    let child = match Command::new(&sidecar_path)
        .args(["--port", &PORT.to_string(), "--host", "127.0.0.1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
        let client = reqwest::Client::new();
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_S);

        loop {
            if tokio::time::Instant::now() > deadline {
                log::error!("Flask health check timed out after {}s", HEALTH_TIMEOUT_S);
                break;
            }

            match client.get(HEALTH_URL).send().await {
                Ok(resp) if resp.status().is_success() => {
                    log::info!("Flask is ready, showing window");
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                    }
                    return;
                }
                _ => {}
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
