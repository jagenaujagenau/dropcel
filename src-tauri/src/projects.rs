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
#[tauri::command(async)]
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

/// Resolve `rel` inside `root/project`, or refuse.
///
/// Canonicalising and then checking containment is the only check that
/// actually holds: a `..`-segment scan misses absolute paths entirely, because
/// `Path::join` *discards* the base when the argument is absolute
/// (`root.join("blog").join("/etc/passwd")` is `/etc/passwd`), and it also
/// misses symlinks pointing out of the tree. Containment is checked against
/// the *project* directory rather than the root, so one project can't be used
/// to read another's files.
pub(crate) fn safe_project_path(root: &Path, project: &str, rel: &str) -> AppResult<PathBuf> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Validation(format!("invalid project name: {project}")));
    }
    let dir = root.join(project);
    let path = dir.join(rel);
    let canonical_dir = dir
        .canonicalize()
        .map_err(|_| AppError::NotFound(format!("{project} is not in the folder")))?;
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::NotFound(format!("{rel} not found in {project}")))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(AppError::Validation("path escapes the project".into()));
    }
    Ok(canonical)
}

/// Read a single file inside a project (e.g. package.json) for framework
/// detection. Returns None when the file does not exist. Capped at 512 KB so a
/// stray binary can't be pulled across IPC.
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn list_project_entries(
    state: State<'_, WatcherState>,
    project: String,
) -> AppResult<Vec<String>> {
    let root = state.root.lock().unwrap().clone();
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Validation(format!("invalid project name: {project}")));
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
/// Public because `tauri::generate_handler!` needs the real path to a
/// command: it expands to sibling macro items alongside each `#[tauri::command]`
/// function, and a `pub use` re-export carries the function but not those.
pub mod import;
mod naming;

/// Move a project folder to the OS trash — recoverable, never rm -rf.
/// Watching stops via the normal filesystem-removal path.
#[tauri::command(async)]
pub fn trash_project(state: State<'_, WatcherState>, project: String) -> AppResult<()> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Validation(format!("invalid project name: {project}")));
    }
    let root = state.root.lock().unwrap().clone();
    let dir = root.join(&project);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("{project} is not in the folder anymore")));
    }
    trash::delete(&dir).map_err(|e| AppError::Message(format!("could not move {project} to trash: {e}")))
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

    /// `Path::join` discards the base for an absolute argument, so a scan for
    /// `..` segments — which is what the deploy-file reader used to do — lets
    /// `/etc/passwd` through untouched. Containment has to be checked after
    /// canonicalising.
    #[test]
    fn safe_project_path_refuses_to_escape_the_project() {
        let root = scratch("safe-path");
        let project = root.join("blog");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("index.html"), "<h1>hi</h1>").unwrap();
        // A sibling project, and a file outside the root entirely.
        std::fs::create_dir_all(root.join("other")).unwrap();
        std::fs::write(root.join("other/secret.txt"), "nope").unwrap();
        std::fs::write(root.join("outside.txt"), "nope").unwrap();

        // The legitimate case still resolves.
        assert!(safe_project_path(&root, "blog", "index.html").is_ok());

        // An absolute path must not silently replace the base.
        assert!(safe_project_path(&root, "blog", "/etc/hosts").is_err());
        assert!(safe_project_path(
            &root,
            "blog",
            root.join("outside.txt").to_str().unwrap()
        )
        .is_err());
        // …nor may one project reach into another.
        assert!(safe_project_path(&root, "blog", "../other/secret.txt").is_err());
    }
}
