use tauri::Manager;

use crate::{db, folder_icons, logger, projects, tray, watcher};
#[cfg(target_os = "macos")]
use crate::tray_drop;

/// Ordered app wiring, called once from the tauri setup closure.
/// Ordering constraint: logger before db (so db failures are loggable), db
/// before the root_folder read, root before watcher/icons which consume it.
pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Database lives in the platform app-data dir.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    let app_logger = logger::Logger::new(data_dir.join("logs"))?;
    app_logger.write(
        "info",
        "app",
        &format!("Dropcel starting (v{})", app.package_info().version),
    );
    app.manage(app_logger);

    let database = db::open(&data_dir.join("vercel-folder.db"))?;

    // Root folder: persisted setting, falling back to ~/Vercel.
    let root = database
        .get_setting("root_folder")?
        .map(std::path::PathBuf::from)
        .unwrap_or_else(projects::default_root);
    app.manage(database);

    let watcher_state = watcher::WatcherState::new(root.clone());
    app.manage(watcher_state);
    watcher::start(app.handle().clone(), &app.state::<watcher::WatcherState>())?;

    folder_icons::set_dock_icon();
    let icon_cache = folder_icons::FolderIconCache::default();
    folder_icons::apply_root_icon(&icon_cache, &root);
    app.manage(icon_cache);

    tray::init(app.handle())?;
    #[cfg(target_os = "macos")]
    tray_drop::attach(app.handle());
    Ok(())
}
