use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri::RunEvent;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const PORT: u16 = 5000;
const HEALTH_URL: &str = "http://127.0.0.1:5000/health";
const HEALTH_POLL_MS: u64 = 500;
const HEALTH_TIMEOUT_S: u64 = 30;

struct SidecarState {
    child: Option<CommandChild>,
}

/// On macOS, PyInstaller --onedir needs `_internal/` adjacent to the exe.
/// Tauri puts externalBin in Contents/MacOS/ and resources in Contents/Resources/.
/// Create a symlink: Contents/MacOS/_internal → Contents/Resources/_internal
#[cfg(target_os = "macos")]
fn fix_macos_internal_dir(app: &tauri::App) {
    use std::fs;
    use std::os::unix::fs as unix_fs;

    let resource_dir = app.path().resource_dir().ok();
    if let Some(res_dir) = resource_dir {
        let internal_src = res_dir.join("_internal");
        if internal_src.exists() {
            // The exe lives in Contents/MacOS/
            if let Some(macos_dir) = res_dir.parent() {
                let macos_internal = macos_dir.join("MacOS").join("_internal");
                if !macos_internal.exists() {
                    if let Err(e) = unix_fs::symlink(&internal_src, &macos_internal) {
                        log::warn!("Failed to symlink _internal: {}", e);
                    } else {
                        log::info!("Symlinked _internal for PyInstaller");
                    }
                }
            }
        }
    }
}

fn spawn_sidecar(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    fix_macos_internal_dir(app);

    let shell = app.shell();
    let cmd = shell
        .sidecar("stock-entry-server")
        .expect("failed to create sidecar command")
        .args(["--port", &PORT.to_string(), "--host", "127.0.0.1"]);

    let (mut rx, child) = cmd.spawn().expect("failed to spawn sidecar");

    // Store child handle for cleanup
    let state = app.state::<Mutex<SidecarState>>();
    {
        let mut s = state.lock().unwrap();
        s.child = Some(child);
    }

    // Forward sidecar stdout/stderr to logs
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[flask] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[flask] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    log::info!("[flask] terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });
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
    if let Some(child) = s.child.take() {
        log::info!("Killing Flask sidecar");
        let _ = child.kill();
    }
}

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
