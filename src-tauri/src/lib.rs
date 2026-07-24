mod commands;
mod credentials;
mod db;
mod error;
mod files;
mod folder_icons;
mod git;
mod logger;
mod network;
mod projects;
mod screenshot;
mod startup;
mod tray;
#[cfg(target_os = "macos")]
mod tray_drop;
mod watcher;

use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(projects::PendingDrops::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| startup::init(app))
        // Closing the window keeps the app alive in the tray — deployments
        // continue in the background, Dropbox-style.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        // Command registry — tauri allows exactly one invoke_handler, so every
        // module's commands are listed here, grouped by module.
        .invoke_handler(tauri::generate_handler![
            // commands: db pass-throughs + watcher controls
            commands::db_list_projects,
            commands::db_upsert_project,
            commands::db_rename_project,
            commands::db_set_project_link,
            commands::db_set_auto_deploy,
            commands::db_set_locked_branch,
            commands::db_set_remote_repo,
            commands::db_set_project_framework,
            commands::db_delete_project,
            commands::db_insert_deployment,
            commands::db_update_deployment,
            commands::db_set_deployment_public_url,
            commands::db_set_deployment_vercel_ids,
            commands::db_set_project_team,
            commands::db_append_log,
            commands::db_list_deployments,
            commands::db_latest_deployments,
            commands::db_get_logs,
            commands::db_add_domain,
            commands::db_set_domain_verified,
            commands::db_remove_domain,
            commands::db_list_domains,
            commands::db_get_setting,
            commands::db_set_setting,
            commands::set_watch_paused,
            commands::get_watch_paused,
            commands::set_root_folder,
            // logger
            logger::log_event,
            logger::get_log_path,
            // projects: root folder scanning + imports
            projects::get_root_folder,
            projects::scan_projects,
            projects::read_project_file,
            projects::list_project_entries,
            projects::open_root_folder,
            projects::trash_project,
            projects::import_dropped_path,
            projects::take_pending_drops,
            projects::create_example_project,
            projects::adopt_loose_files,
            // screenshot: deployment snapshots
            screenshot::snapshot_support,
            screenshot::capture_snapshot,
            screenshot::get_snapshot,
            screenshot::get_snapshots_batch,
            screenshot::delete_snapshot,
            // git
            git::git_info,
            // network
            network::check_online,
            // files: deploy manifests + link files
            files::collect_deploy_files,
            files::project_content_digest,
            files::read_file_b64,
            files::write_project_link,
            files::remove_project_link,
            // credentials: keychain tokens
            credentials::get_vercel_token,
            credentials::set_vercel_token,
            credentials::delete_vercel_token,
            credentials::detect_cli_token,
            credentials::get_vercel_refresh_token,
            credentials::set_vercel_refresh_token,
            credentials::delete_vercel_refresh_token,
            // tray
            tray::update_tray,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Dock-icon drops / "Open With" (macOS): stash the paths and
            // nudge the frontend, which drains them through the same import
            // flow as window and tray drops.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::{Emitter, Manager};
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if !paths.is_empty() {
                    let pending = app_handle.state::<projects::PendingDrops>();
                    pending.0.lock().unwrap().extend(paths);
                    let _ = app_handle.emit("drops:available", ());
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
