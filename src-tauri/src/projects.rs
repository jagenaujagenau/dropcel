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
#[tauri::command(async)]
pub fn import_dropped_path(state: State<'_, WatcherState>, path: String) -> AppResult<String> {
    let root = state.root.lock().unwrap().clone();
    import_dropped_path_in(&root, Path::new(&path))
}

fn import_dropped_path_in(root: &Path, src: &Path) -> AppResult<String> {
    if !src.exists() {
        return Err(AppError::NotFound(format!("{} does not exist", src.display())));
    }
    if src.starts_with(root) {
        return Err(AppError::Validation(
            "That's already inside your Vercel folder.".into(),
        ));
    }

    if src.is_dir() {
        let base = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".into());
        let name = unique_project_name(root, &base);
        copy_dir(src, &root.join(&name))?;
        Ok(name)
    } else {
        // Single file: only a web page is a site on its own, and it becomes
        // index.html so it deploys immediately.
        //
        // Anything else is refused rather than wrapped. A lone photo.png used
        // to become photo/photo.png — a folder with no index.html and no
        // package.json, which `isDeployable` skips, so it never deployed and
        // never appeared in the UI, while the drop had already reported
        // "Deploying photo…". Failing here costs the user nothing (no stray
        // folder is left behind) and the message reaches the same toast.
        let is_html = src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
            .unwrap_or(false);
        if !is_html {
            let file = src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "That file".into());
            return Err(AppError::Validation(format!(
                "{file} can't be a site on its own. Put it in a folder with an index.html, then drop the folder."
            )));
        }
        let stem = src
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "site".into());
        let name = unique_project_name(root, &stem);
        let dir = root.join(&name);
        std::fs::create_dir_all(&dir)?;
        std::fs::copy(src, dir.join("index.html"))?;
        Ok(name)
    }
}

/// Loose files copied straight into the root (Finder, not the app's drop
/// targets) aren't projects and would sit there un-deployed — breaking the
/// "in the folder = live" promise. Adopt web pages: move each root-level
/// .html/.htm into its own project folder as index.html. Other file types
/// are left alone.
#[tauri::command(async)]
pub fn adopt_loose_files(state: State<'_, WatcherState>) -> AppResult<Vec<String>> {
    let root = state.root.lock().unwrap().clone();
    adopt_loose_files_in(&root)
}

fn adopt_loose_files_in(root: &Path) -> AppResult<Vec<String>> {
    let mut adopted = vec![];
    if !root.is_dir() {
        return Ok(adopted);
    }
    for entry in std::fs::read_dir(root)? {
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
        let project = unique_project_name(root, &stem);
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

        let adopted = adopt_loose_files_in(&root).unwrap();

        assert_eq!(adopted, vec!["landing".to_string()]);
        assert!(root.join("landing/index.html").is_file());
        assert!(!root.join("landing.html").exists());
        assert!(root.join("notes.txt").is_file());
        assert!(root.join(".hidden.html").exists());
    }

    #[test]
    fn import_copies_dir_and_wraps_html_file() {
        let root = scratch("import-root");
        let elsewhere = scratch("import-src");
        std::fs::create_dir_all(elsewhere.join("blog")).unwrap();
        std::fs::write(elsewhere.join("blog/index.html"), "<h1/>").unwrap();
        std::fs::write(elsewhere.join("Page.HTM"), "<p/>").unwrap();

        assert_eq!(import_dropped_path_in(&root, &elsewhere.join("blog")).unwrap(), "blog");
        assert!(root.join("blog/index.html").is_file());
        // Single HTML file becomes <stem>/index.html.
        assert_eq!(import_dropped_path_in(&root, &elsewhere.join("Page.HTM")).unwrap(), "Page");
        assert!(root.join("Page/index.html").is_file());

        // Guards: missing source and sources already under the root.
        assert!(matches!(
            import_dropped_path_in(&root, &elsewhere.join("nope")),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            import_dropped_path_in(&root, &root.join("blog")),
            Err(AppError::Validation(_))
        ));
    }

    /// A lone non-web file is refused outright. The old behaviour wrapped it
    /// in a folder that `isDeployable` then skipped: nothing deployed, nothing
    /// showed up in the UI, and the drop still said "Deploying photo…". The
    /// refusal has to leave the root untouched, or the user is left with an
    /// empty project folder they never asked for.
    #[test]
    fn import_refuses_a_single_non_web_file_without_creating_anything() {
        let root = scratch("import-nonweb-root");
        let elsewhere = scratch("import-nonweb-src");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("photo.png"), [0x89, b'P', b'N', b'G']).unwrap();

        let err = import_dropped_path_in(&root, &elsewhere.join("photo.png")).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                // The message names the file and says what to do instead.
                assert!(msg.contains("photo.png"), "{msg}");
                assert!(msg.contains("index.html"), "{msg}");
            }
            other => panic!("expected a validation error, got {other:?}"),
        }

        assert!(!root.join("photo").exists(), "no stray project folder");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "root untouched");
        // And the source file is still where the user left it.
        assert!(elsewhere.join("photo.png").is_file());
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
