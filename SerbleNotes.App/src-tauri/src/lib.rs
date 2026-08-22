//! The Tauri shell.
//!
//! It is deliberately thin. The whole client - the editor, the version DAG, every byte of crypto -
//! is the same React app and the same Rust core that the web client runs, loaded here in a webview
//! rather than a browser tab. The core is not linked into this binary and not reimplemented here:
//! it is the same crate, compiled to WASM, running inside the webview. One copy of the logic that
//! turns stored bytes back into someone's notes, whichever client they are using.
//!
//! What a native shell adds is the two things a browser tab cannot do:
//!
//! 1. **A real keychain** for the unlocked vault key, so "enter the password once per device" means
//!    once, and the key is not sitting in local storage.
//! 2. **A deep link** so the OAuth redirect can come back to the app instead of to a web page.
//!
//! Exporting and importing a vault adds a third of the same kind - the OS file dialogs - and it is
//! the plugins that do it, for the same reason: the archive itself is built and read in the webview,
//! by the same code the web client runs, and the shell only puts the bytes where the user pointed.

use tauri::Manager;

mod secrets;

/// Works around a WebKitGTK crash on Wayland with NVIDIA's proprietary driver.
///
/// WebKitGTK hands its rendered frames to the compositor as DMABUF buffers. That path is broken on
/// the NVIDIA driver, and the failure is not graceful: the window never appears and the process dies
/// with `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`, which names neither
/// WebKit nor the driver. WebKitGTK's own MiniBrowser fails the same way on such a machine, so this
/// is the environment rather than anything we do - but "install it and it crashes" is not something
/// to leave for the user to diagnose.
///
/// Narrow on purpose. Disabling the DMABUF renderer costs some rendering performance, so it is only
/// done where it is needed: Wayland, and this driver. X11 sessions and every other GPU keep the fast
/// path. Setting the variable yourself always wins, in either direction.
#[cfg(target_os = "linux")]
fn survive_nvidia_on_wayland() {
    const FLAG: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    if std::env::var_os(FLAG).is_some() {
        return;
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return;
    }
    // The driver's own kernel module, which is present exactly when the proprietary stack is loaded.
    if !std::path::Path::new("/sys/module/nvidia_drm").exists() {
        return;
    }

    // Before anything starts a thread, which is the rule this call comes with.
    std::env::set_var(FLAG, "1");
}

fn store(app: &tauri::AppHandle) -> Result<secrets::Store, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("This device has nowhere to store app data: {e}"))?;
    Ok(secrets::Store::new(dir))
}

#[tauri::command]
fn secret_set(app: tauri::AppHandle, id: String, value: String) -> Result<(), String> {
    store(&app)?.set(&id, &value)
}

#[tauri::command]
fn secret_get(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    store(&app)?.get(&id)
}

#[tauri::command]
fn secret_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    store(&app)?.delete(&id)
}

/// Which store the keys are actually in, so the client can say so rather than imply a guarantee it
/// does not have. Never invent a reassuring answer here.
#[tauri::command]
fn secret_backend(app: tauri::AppHandle) -> Result<&'static str, String> {
    Ok(store(&app)?.backend())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    survive_nvidia_on_wayland();

    // Only the desktop branch below adds to it; on mobile it is used as it is built.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Windows and Linux answer a deep link by starting the app again with the URL as an
        // argument. Without this the user would get a second, signed-out window every time they
        // came back from Serble; with it the running instance is handed the URL and raised.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            secret_set,
            secret_get,
            secret_delete,
            secret_backend
        ])
        .setup(|_app| {
            // Installers register the scheme; a development build has no installer, so it registers
            // itself. Doing this in a release build would rewrite whatever the installer set up.
            #[cfg(all(desktop, debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Serble Notes failed to start");
}
