use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use sha1::{Digest, Sha1};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::watcher::{is_ignored_component, WatcherState};

/// File collection for REST-API deployments: walk the project, skip the same
/// noise the watcher ignores, and hand back a manifest of relative paths with
/// SHA-1 digests — the shape Vercel's deployment API wants. Content crosses
/// IPC as base64 only for the files Vercel reports missing.

const MAX_FILES: usize = 10_000;
const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployFile {
    /// Relative path with forward slashes (API expects unix-style).
    pub path: String,
    pub sha: String,
    pub size: u64,
}

fn validate_project_name(project: &str) -> AppResult<()> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Validation(format!("invalid project name: {project}")));
    }
    Ok(())
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<DeployFile>) -> AppResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_component(&name) || name == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // .git is in the ignore list; .vercel too — nothing else hidden
            // is skipped, dotfiles like .env are already excluded by the
            // shared ignore rules and dot-configs (.eslintrc) should upload.
            walk(&path, base, out)?;
        } else if file_type.is_file() {
            // Copies-in-progress produce temp files that vanish between
            // listing and hashing — skip anything unreadable rather than
            // failing the whole collection.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
            if out.len() >= MAX_FILES {
                return Err(AppError::Message(format!(
                    "project has more than {MAX_FILES} files — is a build output or dependency directory inside it?"
                )));
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let mut hasher = Sha1::new();
            hasher.update(&bytes);
            let sha = hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let rel = path
                .strip_prefix(base)
                .map_err(|_| AppError::Message("walk escaped project".into()))?
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push(DeployFile { path: rel, sha, size: meta.len() });
        }
    }
    Ok(())
}

/// Digest of the whole manifest: identical content ⇒ identical digest.
/// Used to skip auto-deploys when nothing actually changed.
pub fn manifest_digest(files: &[DeployFile]) -> String {
    let mut hasher = Sha1::new();
    for f in files {
        hasher.update(f.path.as_bytes());
        hasher.update(b":");
        hasher.update(f.sha.as_bytes());
        hasher.update(b"\n");
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployManifest {
    pub files: Vec<DeployFile>,
    pub digest: String,
}

fn collect(state: &State<'_, WatcherState>, project: &str) -> AppResult<Vec<DeployFile>> {
    validate_project_name(project)?;
    let root = state.root.lock().unwrap().clone();
    let dir = root.join(project);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("{project} is not in the folder")));
    }
    let mut out = vec![];
    walk(&dir, &dir, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn collect_deploy_files(
    state: State<'_, WatcherState>,
    project: String,
) -> AppResult<DeployManifest> {
    let files = collect(&state, &project)?;
    let digest = manifest_digest(&files);
    Ok(DeployManifest { files, digest })
}

/// Digest only — the cheap "did anything actually change?" check.
#[tauri::command]
pub fn project_content_digest(
    state: State<'_, WatcherState>,
    project: String,
) -> AppResult<String> {
    Ok(manifest_digest(&collect(&state, &project)?))
}

/// Raw file content, base64-encoded, for uploading to Vercel.
#[tauri::command]
pub fn read_file_b64(
    state: State<'_, WatcherState>,
    project: String,
    path: String,
) -> AppResult<String> {
    validate_project_name(&project)?;
    if path.split('/').any(|seg| seg == "..") {
        return Err(AppError::Validation("path escapes the project".into()));
    }
    let root = state.root.lock().unwrap().clone();
    let full: PathBuf = root.join(&project).join(&path);
    let bytes = std::fs::read(&full)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write the .vercel/project.json link file ourselves (the CLI used to).
/// It travels with the folder on rename, which the rename guard relies on.
#[tauri::command]
pub fn write_project_link(
    state: State<'_, WatcherState>,
    project: String,
    project_id: String,
    org_id: String,
    project_name: String,
) -> AppResult<()> {
    validate_project_name(&project)?;
    let root = state.root.lock().unwrap().clone();
    let dir = root.join(&project).join(".vercel");
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::json!({
        "projectId": project_id,
        "orgId": org_id,
        "projectName": project_name,
    });
    let body = serde_json::to_vec_pretty(&json)
        .map_err(|e| AppError::Message(e.to_string()))?;
    std::fs::write(dir.join("project.json"), body).map_err(Into::into)
}

/// Delete the .vercel/project.json link (used when re-linking a project to a
/// different account: next deploy creates a fresh project).
#[tauri::command]
pub fn remove_project_link(state: State<'_, WatcherState>, project: String) -> AppResult<()> {
    validate_project_name(&project)?;
    let root = state.root.lock().unwrap().clone();
    let link = root.join(&project).join(".vercel/project.json");
    if link.is_file() {
        std::fs::remove_file(&link)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("vercel-folder-files-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn walk_collects_files_and_skips_ignored() {
        let dir = scratch("walk");
        std::fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/app.ts"), "export {}").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(dir.join("node_modules/x/i.js"), "no").unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: x").unwrap();
        std::fs::write(dir.join(".env.local"), "SECRET=1").unwrap();
        std::fs::write(dir.join(".eslintrc"), "{}").unwrap();

        let mut out = vec![];
        walk(&dir, &dir, &mut out).unwrap();
        let paths: Vec<_> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"index.html"));
        assert!(paths.contains(&"src/app.ts"));
        assert!(paths.contains(&".eslintrc"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains(".git")));
        assert!(!paths.iter().any(|p| p.contains(".env")));
    }

    #[test]
    fn manifest_digest_is_stable_and_content_sensitive() {
        let dir = scratch("digest");
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.join("b.txt"), "world").unwrap();
        let collect_digest = |d: &PathBuf| {
            let mut out = vec![];
            walk(d, d, &mut out).unwrap();
            out.sort_by(|a, b| a.path.cmp(&b.path));
            manifest_digest(&out)
        };
        let d1 = collect_digest(&dir);
        // Unchanged content → identical digest (mtime doesn't matter).
        assert_eq!(d1, collect_digest(&dir));
        // Changed content → different digest.
        std::fs::write(dir.join("a.txt"), "hello!").unwrap();
        assert_ne!(d1, collect_digest(&dir));
    }

    #[test]
    fn sha1_matches_known_vector() {
        let dir = scratch("sha");
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let mut out = vec![];
        walk(&dir, &dir, &mut out).unwrap();
        // sha1("hello")
        assert_eq!(out[0].sha, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
        assert_eq!(out[0].size, 5);
    }
}
