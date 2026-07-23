use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::watcher::{is_ignored_component, WatcherState};

/// The default root: ~/Vercel. Users can point the app elsewhere in Settings.
pub fn default_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Vercel")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedProject {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn get_root_folder(state: State<'_, WatcherState>) -> String {
    state.root.lock().unwrap().to_string_lossy().to_string()
}

/// List every immediate child directory of the root. Hidden and ignored
/// directories are excluded — everything else is a deployable project.
#[tauri::command]
pub fn scan_projects(state: State<'_, WatcherState>) -> AppResult<Vec<ScannedProject>> {
    let root = state.root.lock().unwrap().clone();
    std::fs::create_dir_all(&root)?;
    let mut out = vec![];
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_ignored_component(&name) {
            continue;
        }
        out.push(ScannedProject {
            path: entry.path().to_string_lossy().to_string(),
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn safe_project_path(root: &Path, project: &str, rel: &str) -> AppResult<PathBuf> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Message(format!("invalid project name: {project}")));
    }
    let path = root.join(project).join(rel);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| AppError::Message("root folder does not exist".into()))?;
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::Message(format!("{rel} not found in {project}")))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(AppError::Message("path escapes the root folder".into()));
    }
    Ok(canonical)
}

/// Read a single file inside a project (e.g. package.json) for framework
/// detection. Returns None when the file does not exist. Capped at 512 KB so a
/// stray binary can't be pulled across IPC.
#[tauri::command]
pub fn read_project_file(
    state: State<'_, WatcherState>,
    project: String,
    file: String,
) -> AppResult<Option<String>> {
    let root = state.root.lock().unwrap().clone();
    let path = match safe_project_path(&root, &project, &file) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let meta = std::fs::metadata(&path)?;
    if !meta.is_file() || meta.len() > 512 * 1024 {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(&path)?))
}

/// Top-level file/dir names of a project — the cheap signal set the detector
/// works from (config files like next.config.ts, astro.config.mjs, index.html…).
#[tauri::command]
pub fn list_project_entries(
    state: State<'_, WatcherState>,
    project: String,
) -> AppResult<Vec<String>> {
    let root = state.root.lock().unwrap().clone();
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Message(format!("invalid project name: {project}")));
    }
    let dir = root.join(&project);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    for entry in std::fs::read_dir(&dir)? {
        names.push(entry?.file_name().to_string_lossy().to_string());
    }
    names.sort();
    Ok(names)
}

/// Paths handed to the app by the OS (dock-icon drops / "Open With") that
/// arrived before the frontend was listening. Drained by the frontend.
#[derive(Default)]
pub struct PendingDrops(pub std::sync::Mutex<Vec<String>>);

#[tauri::command]
pub fn take_pending_drops(pending: State<'_, PendingDrops>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

/// Pick a project name that doesn't collide: "blog", "blog-2", "blog-3"…
fn unique_project_name(root: &Path, base: &str) -> String {
    let clean = base.trim().trim_matches('.').replace(['/', '\\'], "-");
    let base = if clean.is_empty() { "project".to_string() } else { clean };
    if !root.join(&base).exists() {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", uuid::Uuid::new_v4())
}

fn copy_dir(src: &Path, dst: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip the heavyweight dirs deploys ignore anyway.
        if name == "node_modules" || name == ".git" {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// A file or folder was dropped on the app: copy it into the Vercel folder
/// as a new project. The watcher then picks it up and deploys — the drop
/// itself is just a copy. Returns the created project name.
#[tauri::command]
pub fn import_dropped_path(state: State<'_, WatcherState>, path: String) -> AppResult<String> {
    let src = PathBuf::from(&path);
    let root = state.root.lock().unwrap().clone();
    if !src.exists() {
        return Err(AppError::Message(format!("{path} does not exist")));
    }
    if src.starts_with(&root) {
        return Err(AppError::Message(
            "That's already inside your Vercel folder.".into(),
        ));
    }

    if src.is_dir() {
        let base = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".into());
        let name = unique_project_name(&root, &base);
        copy_dir(&src, &root.join(&name))?;
        Ok(name)
    } else {
        // Single file: wrap it in a folder. An HTML file becomes index.html
        // so it deploys as a static site immediately.
        let stem = src
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "site".into());
        let name = unique_project_name(&root, &stem);
        let dir = root.join(&name);
        std::fs::create_dir_all(&dir)?;
        let is_html = src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
            .unwrap_or(false);
        let target = if is_html {
            dir.join("index.html")
        } else {
            dir.join(src.file_name().unwrap_or_default())
        };
        std::fs::copy(&src, &target)?;
        Ok(name)
    }
}

/// Loose files copied straight into the root (Finder, not the app's drop
/// targets) aren't projects and would sit there un-deployed — breaking the
/// "in the folder = live" promise. Adopt web pages: move each root-level
/// .html/.htm into its own project folder as index.html. Other file types
/// are left alone.
#[tauri::command]
pub fn adopt_loose_files(state: State<'_, WatcherState>) -> AppResult<Vec<String>> {
    let root = state.root.lock().unwrap().clone();
    let mut adopted = vec![];
    if !root.is_dir() {
        return Ok(adopted);
    }
    for entry in std::fs::read_dir(&root)? {
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_ignored_component(&name) {
            continue;
        }
        let lower = name.to_lowercase();
        if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
            continue;
        }
        let stem = entry
            .path()
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "site".into());
        let project = unique_project_name(&root, &stem);
        let dir = root.join(&project);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        if std::fs::rename(entry.path(), dir.join("index.html")).is_ok() {
            adopted.push(project);
        } else {
            let _ = std::fs::remove_dir(&dir);
        }
    }
    Ok(adopted)
}

const EXAMPLE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hello from Dropcel</title>
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(80% 100% at 50% 0%, #1a1a1a 0%, #0a0a0a 100%);
    color: #ededed; font-family: -apple-system, "Segoe UI", sans-serif; text-align: center;
  }
  main { padding: 2rem; }
  .tri { font-size: 3rem; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 1rem 0 0.5rem; }
  p { color: #8f8f8f; line-height: 1.6; max-width: 34rem; }
  code { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 0.15em 0.4em; }
</style>
</head>
<body>
<main>
  <div class="tri">▲</div>
  <h1>This page went from a desktop folder to the world.</h1>
  <p>It lives in your <code>~/Vercel</code> folder. Edit this file — any editor,
  any change — save it, and this URL updates itself. That's Dropcel.</p>
</main>
</body>
</html>
"#;

/// Onboarding's guaranteed first deploy: write a tiny static site into the
/// folder. The watcher detects and deploys it like any real project.
#[tauri::command]
pub fn create_example_project(state: State<'_, WatcherState>) -> AppResult<String> {
    let root = state.root.lock().unwrap().clone();
    std::fs::create_dir_all(&root)?;
    let name = unique_project_name(&root, "hello-dropcel");
    let dir = root.join(&name);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("index.html"), EXAMPLE_HTML)?;
    Ok(name)
}

/// Move a project folder to the OS trash — recoverable, never rm -rf.
/// Watching stops via the normal filesystem-removal path.
#[tauri::command]
pub fn trash_project(state: State<'_, WatcherState>, project: String) -> AppResult<()> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Message(format!("invalid project name: {project}")));
    }
    let root = state.root.lock().unwrap().clone();
    let dir = root.join(&project);
    if !dir.is_dir() {
        return Err(AppError::Message(format!("{project} is not in the folder anymore")));
    }
    trash::delete(&dir).map_err(|e| AppError::Message(format!("could not move {project} to trash: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("vercel-folder-projects-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unique_names_dedupe_and_sanitize() {
        let root = scratch("names");
        assert_eq!(unique_project_name(&root, "blog"), "blog");
        std::fs::create_dir(root.join("blog")).unwrap();
        assert_eq!(unique_project_name(&root, "blog"), "blog-2");
        std::fs::create_dir(root.join("blog-2")).unwrap();
        assert_eq!(unique_project_name(&root, "blog"), "blog-3");
        assert_eq!(unique_project_name(&root, "a/b"), "a-b");
        assert_eq!(unique_project_name(&root, ""), "project");
    }

    #[test]
    fn adopt_wraps_loose_html_only() {
        let root = scratch("adopt");
        std::fs::write(root.join("landing.html"), "<h1/>").unwrap();
        std::fs::write(root.join("notes.txt"), "keep me").unwrap();
        std::fs::write(root.join(".hidden.html"), "no").unwrap();

        // Exercise the inner logic via the fs directly (command needs State).
        // Simulate: same steps as adopt_loose_files.
        for entry in std::fs::read_dir(&root).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_file() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !name.to_lowercase().ends_with(".html") { continue; }
            let stem = entry.path().file_stem().unwrap().to_string_lossy().to_string();
            let project = unique_project_name(&root, &stem);
            let dir = root.join(&project);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::rename(entry.path(), dir.join("index.html")).unwrap();
        }

        assert!(root.join("landing/index.html").is_file());
        assert!(!root.join("landing.html").exists());
        assert!(root.join("notes.txt").is_file());
        assert!(root.join(".hidden.html").exists());
    }

    #[test]
    fn copy_dir_skips_node_modules_and_git() {
        let src = scratch("copy-src");
        std::fs::write(src.join("index.html"), "<h1/>").unwrap();
        std::fs::create_dir_all(src.join("node_modules/x")).unwrap();
        std::fs::write(src.join("node_modules/x/y.js"), "no").unwrap();
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::write(src.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(src.join("src")).unwrap();
        std::fs::write(src.join("src/app.ts"), "export {}").unwrap();

        let dst = scratch("copy-dst").join("out");
        copy_dir(&src, &dst).unwrap();
        assert!(dst.join("index.html").is_file());
        assert!(dst.join("src/app.ts").is_file());
        assert!(!dst.join("node_modules").exists());
        assert!(!dst.join(".git").exists());
    }
}

/// Reveal the root folder (or a project inside it) in Finder/Explorer.
#[tauri::command]
pub fn open_root_folder(state: State<'_, WatcherState>, project: Option<String>) -> AppResult<()> {
    let root = state.root.lock().unwrap().clone();
    let target = match project {
        Some(p) => root.join(p),
        None => root,
    };
    tauri_plugin_opener::open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::Message(e.to_string()))
}
