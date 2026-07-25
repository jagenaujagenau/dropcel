//! Deployment snapshots. Vercel's dashboard screenshots come from an
//! internal service with no public API, so we capture our own: a headless
//! Chromium-family browser renders the deployed URL to a PNG stored in the
//! app data dir. If no compatible browser is installed the feature quietly
//! degrades to a placeholder in the UI.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::error::{AppError, AppResult};

/// Capture size — a desktop viewport, so pages lay out as their authors
/// intended rather than hitting a mobile breakpoint.
const VIEWPORT: &str = "1280,800";

/// Stored size. See `downscale_in_place` for why this is far below `VIEWPORT`.
const STORED_WIDTH: u32 = 800;

fn browser_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    #[cfg(target_os = "macos")]
    {
        for app in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Arc.app/Contents/MacOS/Arc",
        ] {
            candidates.push(PathBuf::from(app));
        }
    }
    #[cfg(target_os = "linux")]
    {
        for bin in [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
        ] {
            candidates.push(PathBuf::from(bin));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for base in [
            std::env::var("PROGRAMFILES").unwrap_or_default(),
            std::env::var("PROGRAMFILES(X86)").unwrap_or_default(),
            std::env::var("LOCALAPPDATA").unwrap_or_default(),
        ] {
            if base.is_empty() {
                continue;
            }
            candidates.push(PathBuf::from(&base).join("Google/Chrome/Application/chrome.exe"));
            candidates.push(PathBuf::from(&base).join("Microsoft/Edge/Application/msedge.exe"));
            candidates.push(PathBuf::from(&base).join("BraveSoftware/Brave-Browser/Application/brave.exe"));
        }
    }
    candidates
}

fn resolve_browser() -> Option<PathBuf> {
    browser_candidates().into_iter().find(|p| p.is_file())
}

fn ensure_https(url: &str) -> AppResult<()> {
    if !url.starts_with("https://") {
        return Err(AppError::Validation(format!("refusing to snapshot non-https url: {url}")));
    }
    Ok(())
}

fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Message(e.to_string()))
}

fn snapshot_path_in(data_dir: &std::path::Path, project_id: &str) -> AppResult<PathBuf> {
    let dir = data_dir.join("snapshots");
    std::fs::create_dir_all(&dir)?;
    // project ids are UUIDs we generated — safe as file names.
    Ok(dir.join(format!("{project_id}.png")))
}

fn snapshot_path(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    snapshot_path_in(&data_dir(app)?, project_id)
}

fn encode(path: &PathBuf) -> AppResult<Snapshot> {
    let bytes = std::fs::read(path)?;
    let modified = std::fs::metadata(path)?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(Snapshot {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        captured_at_ms: modified,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub data_url: String,
    pub captured_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSupport {
    pub supported: bool,
    pub browser: Option<String>,
}

#[tauri::command]
pub fn snapshot_support() -> SnapshotSupport {
    let browser = resolve_browser();
    SnapshotSupport {
        supported: browser.is_some(),
        browser: browser.map(|p| p.to_string_lossy().to_string()),
    }
}

/// Render `url` to a PNG for this project. Returns the fresh snapshot.
#[tauri::command]
pub async fn capture_snapshot(
    app: AppHandle,
    project_id: String,
    url: String,
) -> AppResult<Snapshot> {
    ensure_https(&url)?;
    let browser = resolve_browser().ok_or_else(|| {
        AppError::Message(
            "No Chromium-based browser found for snapshots (Chrome, Edge, Brave…).".into(),
        )
    })?;
    let out = snapshot_path(&app, &project_id)?;
    // Write to a temp file first so a failed capture never clobbers the
    // previous good snapshot.
    let tmp = out.with_extension("tmp.png");

    let status = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(&browser)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--hide-scrollbars",
                "--disable-extensions",
                &format!("--window-size={VIEWPORT}"),
                // Give SPAs time to hydrate and paint before the shot.
                "--virtual-time-budget=8000",
                &format!("--screenshot={}", tmp.display()),
                &url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await
    .map_err(|_| AppError::Message("snapshot timed out after 30s".into()))?
    .map_err(|e| AppError::Message(format!("could not launch {}: {e}", browser.display())))?;

    if !status.success() || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Message(format!(
            "snapshot of {url} failed (browser exit {:?})",
            status.code()
        )));
    }
    downscale_in_place(&tmp);
    std::fs::rename(&tmp, &out)?;
    encode(&out)
}

/// Shrink a freshly-captured shot to `STORED_WIDTH` before it is stored.
///
/// The capture stays at `VIEWPORT` so the page lays out as a desktop site,
/// but nothing ever displays it at that size: the card art is ~400 CSS px
/// wide, so `STORED_WIDTH` is already 2× for a retina screen. Storing the full
/// 1280px shot meant every snapshot crossed IPC base64-encoded at ~4× the
/// bytes it needed, then sat in the JS heap for the lifetime of the app —
/// startup hydration alone shipped one per project in a single payload.
///
/// Best-effort by design: this is an optimisation, and a snapshot that fails
/// to re-encode is still a perfectly good snapshot at the original size.
fn downscale_in_place(path: &PathBuf) {
    let Ok(img) = image::open(path) else { return };
    if img.width() <= STORED_WIDTH {
        return;
    }
    let height = (img.height() as f32 * (STORED_WIDTH as f32 / img.width() as f32)).round() as u32;
    // Triangle (bilinear) rather than Lanczos: this is a photographic
    // downscale viewed small, where the sharper filter's ringing on UI edges
    // is more visible than the detail it preserves — and it is much faster.
    let resized = img.resize_exact(STORED_WIDTH, height.max(1), image::imageops::FilterType::Triangle);
    let _ = resized.save(path);
}

/// Load the last stored snapshot for a project, if any.
#[tauri::command(async)]
pub fn get_snapshot(app: AppHandle, project_id: String) -> AppResult<Option<Snapshot>> {
    let path = snapshot_path(&app, &project_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    encode(&path).map(Some)
}

/// Same as `get_snapshot`, batched: startup hydration otherwise costs one
/// IPC round trip per project. A missing/unreadable snapshot for one project
/// is simply absent from the map — it never fails the whole batch.
#[tauri::command(async)]
pub fn get_snapshots_batch(
    app: AppHandle,
    project_ids: Vec<String>,
) -> AppResult<std::collections::HashMap<String, Snapshot>> {
    let mut out = std::collections::HashMap::with_capacity(project_ids.len());
    for project_id in project_ids {
        let Ok(path) = snapshot_path(&app, &project_id) else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        if let Ok(snap) = encode(&path) {
            out.insert(project_id, snap);
        }
    }
    Ok(out)
}

/// Drop a project's snapshot.
///
/// Not a command: forgetting a project is one operation, and the frontend
/// calling this half separately is what used to leave orphaned PNGs behind.
/// `commands::forget_project` is the only caller.
pub fn delete_snapshot_file(app: &AppHandle, project_id: &str) -> AppResult<()> {
    let path = snapshot_path(app, project_id)?;
    if path.is_file() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_guard_rejects_everything_else() {
        assert!(ensure_https("https://example.vercel.app").is_ok());
        for url in ["http://example.com", "file:///etc/passwd", "ftp://x", "example.com"] {
            assert!(matches!(ensure_https(url), Err(AppError::Validation(_))), "{url}");
        }
    }

    /// Card art is ~400 CSS px wide; storing the full 1280px capture meant
    /// every snapshot crossed IPC base64-encoded at roughly 4x the bytes it
    /// needed and stayed in the JS heap for the session.
    #[test]
    fn downscale_shrinks_a_capture_and_keeps_its_aspect_ratio() {
        let dir = std::env::temp_dir().join(format!("dropcel-shot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shot.png");

        // Deterministic pseudo-noise, not a gradient: a linear ramp compresses
        // almost perfectly at any size, so the full-size PNG would come out
        // *smaller* than the downscaled one and the byte assertion below would
        // be measuring PNG's filters rather than the resize. Real screenshots
        // are incompressible enough that pixel count dominates.
        let mut seed: u32 = 0x1234_5678;
        image::RgbaImage::from_fn(1280, 800, |_, _| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let b = (seed >> 16) as u8;
            image::Rgba([b, b.wrapping_mul(3), b.wrapping_add(97), 255])
        })
        .save(&path)
        .unwrap();
        let before = std::fs::metadata(&path).unwrap().len();

        downscale_in_place(&path);

        let after_img = image::open(&path).unwrap();
        assert_eq!(after_img.width(), STORED_WIDTH);
        // 1280x800 is 16:10, so 800 wide must land on 500 tall.
        assert_eq!(after_img.height(), 500);
        assert!(std::fs::metadata(&path).unwrap().len() < before);

        // Already small enough: left exactly as-is rather than re-encoded.
        let small = dir.join("small.png");
        image::RgbaImage::new(320, 200).save(&small).unwrap();
        downscale_in_place(&small);
        assert_eq!(image::open(&small).unwrap().width(), 320);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_path_is_id_png_under_snapshots() {
        let base = std::env::temp_dir()
            .join("vercel-folder-screenshot-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&base);
        let path = snapshot_path_in(&base, "abc-123").unwrap();
        assert_eq!(path, base.join("snapshots/abc-123.png"));
        // The parent dir is created eagerly so the browser can write into it.
        assert!(path.parent().unwrap().is_dir());
    }

    #[test]
    fn browser_candidates_exist_per_os() {
        // Every OS ships a non-empty candidate list; resolution just filters.
        assert!(!browser_candidates().is_empty());
    }
}
