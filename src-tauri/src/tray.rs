use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::folder_icons::{self, FolderIconCache};
use crate::watcher::WatcherState;

pub const TRAY_ID: &str = "main-tray";

// ---- status icon rendering -------------------------------------------------

const ICON_SIZE: u32 = 44;

fn inside_triangle(x: f32, y: f32) -> bool {
    // Apex (22, 9), base corners (6, 35) and (38, 35).
    let (ax, ay) = (22.0, 9.0);
    let (bx, by) = (6.0, 35.0);
    let (cx, cy) = (38.0, 35.0);
    let sign = |px: f32, py: f32, qx: f32, qy: f32, rx: f32, ry: f32| {
        (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
    };
    let d1 = sign(x, y, ax, ay, bx, by);
    let d2 = sign(x, y, bx, by, cx, cy);
    let d3 = sign(x, y, cx, cy, ax, ay);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Render the tray icon for an aggregate status. Idle/ready use a pure black
/// template triangle (macOS recolors it per menubar theme); transient states
/// use a mid-gray triangle (visible on light and dark) plus a colored dot.
fn render_icon(status: &str) -> (Image<'static>, bool) {
    let (dot, template): (Option<[u8; 4]>, bool) = match status {
        "deploying" => (Some([245, 166, 35, 255]), false),
        "failed" => (Some([255, 77, 79, 255]), false),
        _ => (None, true),
    };
    let tri_color: [u8; 3] = if template { [0, 0, 0] } else { [135, 135, 135] };
    let mut rgba = vec![0u8; (ICON_SIZE * ICON_SIZE * 4) as usize];
    const SS: u32 = 3; // supersampling for smooth edges

    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let mut hits = 0u32;
            for sy in 0..SS {
                for sx in 0..SS {
                    let fx = x as f32 + (sx as f32 + 0.5) / SS as f32;
                    let fy = y as f32 + (sy as f32 + 0.5) / SS as f32;
                    if inside_triangle(fx, fy) {
                        hits += 1;
                    }
                }
            }
            let alpha = (hits * 255 / (SS * SS)) as u8;
            let i = ((y * ICON_SIZE + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&[tri_color[0], tri_color[1], tri_color[2], alpha]);
        }
    }

    if let Some([r, g, b, _]) = dot {
        let (cx, cy, radius) = (33.0f32, 33.0f32, 9.0f32);
        for y in 0..ICON_SIZE {
            for x in 0..ICON_SIZE {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                if d <= radius + 1.0 {
                    let i = ((y * ICON_SIZE + x) * 4) as usize;
                    if d <= radius - 2.5 {
                        let a = ((radius - 2.5 - d + 1.0).clamp(0.0, 1.0) * 255.0) as u8;
                        rgba[i..i + 4].copy_from_slice(&[r, g, b, a.max(200)]);
                    } else {
                        // Transparent ring so the dot separates from the triangle.
                        rgba[i..i + 4].copy_from_slice(&[0, 0, 0, 0]);
                    }
                }
            }
        }
        // Redraw the dot fill over the cleared ring interior.
        for y in 0..ICON_SIZE {
            for x in 0..ICON_SIZE {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                if d <= radius - 2.0 {
                    let i = ((y * ICON_SIZE + x) * 4) as usize;
                    let a = ((radius - 2.0 - d + 1.0).clamp(0.0, 1.0) * 255.0) as u8;
                    rgba[i..i + 4].copy_from_slice(&[r, g, b, a]);
                }
            }
        }
    }

    (Image::new_owned(rgba, ICON_SIZE, ICON_SIZE), template)
}

fn aggregate_status(projects: &[TrayProject]) -> &'static str {
    if projects.iter().any(|p| p.status == "deploying") {
        "deploying"
    } else if projects.iter().any(|p| p.status == "failed") {
        "failed"
    } else if projects.iter().any(|p| p.status == "ready") {
        "ready"
    } else {
        "idle"
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayProject {
    pub name: String,
    /// "ready" | "deploying" | "failed" | "idle"
    pub status: String,
    /// Detected framework key (drives the folder icon artwork).
    #[serde(default)]
    pub framework: String,
}

fn status_glyph(status: &str) -> &'static str {
    match status {
        "ready" => "✓",
        "deploying" => "↻",
        "failed" => "!",
        _ => "·",
    }
}

fn build_menu(
    app: &AppHandle,
    projects: &[TrayProject],
    paused: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let header = MenuItem::with_id(app, "header", "Dropcel", false, None::<&str>)?;
    menu.append(&header)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    for p in projects.iter().take(12) {
        let label = format!("{} {}", status_glyph(&p.status), p.name);
        let item = MenuItem::with_id(app, format!("project:{}", p.name), label, true, None::<&str>)?;
        menu.append(&item)?;
    }
    if !projects.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    let open = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "open-folder", "Open Folder", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause Watching", true, paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dropcel", true, Some("CmdOrCtrl+Q"))?;
    menu.append(&open)?;
    menu.append(&folder)?;
    menu.append(&pause)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &[], false)?;
    let (icon, template) = render_icon("idle");
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(template)
        .tooltip("Dropcel")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open-dashboard" => show_main_window(app),
                "open-folder" => {
                    let state: State<'_, WatcherState> = app.state();
                    let _ = crate::projects::open_root_folder(state, None);
                }
                "pause" => {
                    let state: State<'_, WatcherState> = app.state();
                    let paused = !crate::watcher::is_paused(&state);
                    crate::watcher::set_paused(&state, paused);
                    let _ = app.emit("watcher:paused", paused);
                }
                "quit" => app.exit(0),
                other => {
                    if let Some(project) = other.strip_prefix("project:") {
                        show_main_window(app);
                        let _ = app.emit("tray:open-project", project.to_string());
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray menu whenever project statuses change. Called from the
/// frontend orchestrator after every state transition.
#[tauri::command]
pub fn update_tray(
    app: AppHandle,
    state: State<'_, WatcherState>,
    icon_cache: State<'_, FolderIconCache>,
    projects: Vec<TrayProject>,
) -> AppResult<()> {
    let paused = crate::watcher::is_paused(&state);
    let menu =
        build_menu(&app, &projects, paused).map_err(|e| AppError::Message(e.to_string()))?;
    let status = aggregate_status(&projects);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))
            .map_err(|e| AppError::Message(e.to_string()))?;
        let (icon, template) = render_icon(status);
        let _ = tray.set_icon_as_template(template);
        let _ = tray.set_icon(Some(icon));
        let tip = match status {
            "deploying" => "Dropcel — deploying…",
            "failed" => "Dropcel — a deployment failed",
            "ready" => "Dropcel — all deployments ready",
            _ => "Dropcel",
        };
        let _ = tray.set_tooltip(Some(tip));
    }

    // Mirror statuses onto the project folders themselves (macOS Finder).
    let root = state.root.lock().unwrap().clone();
    let statuses: Vec<(String, String, String)> = projects
        .iter()
        .map(|p| (p.name.clone(), p.status.clone(), p.framework.clone()))
        .collect();
    folder_icons::apply_project_icons(&icon_cache, &root, &statuses);
    Ok(())
}

#[cfg(test)]
mod icon_dump_tests {
    use super::*;

    #[test]
    #[ignore] // manual inspection helper: cargo test -- --ignored
    fn dump_icons() {
        for status in ["idle", "deploying", "failed"] {
            let (icon, _) = render_icon(status);
            let img = image::RgbaImage::from_raw(ICON_SIZE, ICON_SIZE, icon.rgba().to_vec()).unwrap();
            let path = std::env::temp_dir().join(format!("tray-{status}.png"));
            img.save(&path).unwrap();
            println!("wrote {}", path.display());
        }
    }
}
