//! Getting things *into* the folder: dropped paths, loose files adopted into
//! projects of their own, and the example site onboarding writes.
//!
//! Every command here delegates to an `*_in(root)` core that takes the root
//! folder as an argument, because a `State<WatcherState>` cannot be built
//! outside a running Tauri app — the split is what makes any of this testable.

use std::path::Path;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::watcher::{is_ignored_component, WatcherState};

use super::naming::{project_name_for_page, unique_project_name};

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
        let name = project_name_for_page(root, &stem);
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
        let project = project_name_for_page(root, &stem);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("vercel-folder-projects-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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

        // A single HTML file becomes <name>/index.html. "Page" is a generic
        // stem, so the name is generated rather than kept.
        let named = import_dropped_path_in(&root, &elsewhere.join("Page.HTM")).unwrap();
        assert!(named.contains('-'), "expected a generated name, got {named}");
        assert!(root.join(&named).join("index.html").is_file());

        // A deliberate stem is kept as-is.
        std::fs::write(elsewhere.join("portfolio.html"), "<p/>").unwrap();
        assert_eq!(
            import_dropped_path_in(&root, &elsewhere.join("portfolio.html")).unwrap(),
            "portfolio"
        );
        assert!(root.join("portfolio/index.html").is_file());

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
