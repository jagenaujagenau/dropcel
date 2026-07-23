use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// Directories and files that must never trigger a deployment.
/// `.env*` is matched by prefix, everything else exactly.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    ".vercel",
    "dist",
    "build",
    "coverage",
    ".DS_Store",
];

pub fn is_ignored_component(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
        || name.starts_with(".env")
        // Finder's custom-icon resource ("Icon\r") — written by our own
        // folder-status icons. Watching it caused a deploy → repaint →
        // event → deploy loop.
        || name == "Icon\r"
        || (name.starts_with("Icon") && name.ends_with('\r'))
}

/// True when any path component is on the ignore list.
pub fn is_ignored_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    rel.components().any(|c| match c {
        Component::Normal(os) => os.to_str().map(is_ignored_component).unwrap_or(false),
        _ => false,
    })
}

/// Extract the top-level project directory name a changed path belongs to.
pub fn project_of(root: &Path, path: &Path) -> Option<(String, bool)> {
    let rel = path.strip_prefix(root).ok()?;
    let mut comps = rel.components();
    let first = match comps.next()? {
        Component::Normal(os) => os.to_str()?.to_string(),
        _ => return None,
    };
    if first.starts_with('.') {
        return None;
    }
    let is_project_dir_itself = comps.next().is_none();
    Some((first, is_project_dir_itself))
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub project: String,
    /// "modified" | "project-added" | "project-removed"
    pub kind: String,
}

/// Reduce a debounced event batch into a deduplicated set of per-project
/// changes. Pure so it is unit-testable without a real filesystem.
pub fn classify_events<'a>(
    root: &Path,
    events: impl Iterator<Item = (&'a EventKind, &'a Vec<PathBuf>)>,
    dir_exists: impl Fn(&Path) -> bool,
) -> Vec<FsChange> {
    let mut out: BTreeSet<FsChange> = BTreeSet::new();
    for (kind, paths) in events {
        for path in paths {
            if is_ignored_path(root, path) {
                continue;
            }
            let Some((project, is_root_dir)) = project_of(root, path) else {
                continue;
            };
            let change_kind = if is_root_dir {
                match kind {
                    EventKind::Create(_) => "project-added",
                    EventKind::Remove(_) => "project-removed",
                    // Metadata-only changes on the project dir itself (xattrs,
                    // Finder icon flags, permissions) are not content changes
                    // — repainting our own status icon must not trigger a
                    // deploy.
                    EventKind::Modify(notify::event::ModifyKind::Metadata(_)) => continue,
                    // A move to Trash is a rename OUT of the tree, which
                    // FSEvents reports as Modify on the dir — not Remove.
                    // Existence disambiguates: gone = removed.
                    _ if !dir_exists(path) => "project-removed",
                    _ => "modified",
                }
            } else {
                "modified"
            };
            out.insert(FsChange {
                project,
                kind: change_kind.to_string(),
            });
        }
    }
    out.into_iter().collect()
}

pub struct WatcherState {
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>>,
    pub root: Mutex<PathBuf>,
    pub paused: AtomicBool,
}

impl WatcherState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            debouncer: Mutex::new(None),
            root: Mutex::new(root),
            paused: AtomicBool::new(false),
        }
    }
}

/// Start (or restart) watching the root folder. Rust applies a short debounce
/// window to collapse editor save storms; the frontend applies a longer
/// per-project debounce before actually deploying.
pub fn start(app: AppHandle, state: &WatcherState) -> AppResult<()> {
    let root = state.root.lock().unwrap().clone();
    std::fs::create_dir_all(&root)?;

    let event_root = root.clone();
    let handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(600),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let changes = classify_events(
                    &event_root,
                    events.iter().map(|e| (&e.event.kind, &e.event.paths)),
                    |p| p.exists(),
                );
                if !changes.is_empty() {
                    let _ = handle.emit("fs:changed", &changes);
                }
            }
            Err(errors) => {
                let msg = errors
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; ");
                crate::logger::log(&handle, "error", "watcher", &msg);
                let _ = handle.emit("watcher:error", msg);
            }
        },
    )
    .map_err(|e| AppError::Watch(e.to_string()))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Watch(e.to_string()))?;

    *state.debouncer.lock().unwrap() = Some(debouncer);
    Ok(())
}

pub fn stop(state: &WatcherState) {
    *state.debouncer.lock().unwrap() = None;
}

pub fn set_paused(state: &WatcherState, paused: bool) {
    state.paused.store(paused, Ordering::SeqCst);
}

pub fn is_paused(state: &WatcherState) -> bool {
    state.paused.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    fn root() -> PathBuf {
        PathBuf::from("/Users/x/Vercel")
    }

    #[test]
    fn ignores_noise_directories() {
        let r = root();
        assert!(is_ignored_path(&r, &r.join("blog/node_modules/react/index.js")));
        assert!(is_ignored_path(&r, &r.join("blog/.git/HEAD")));
        assert!(is_ignored_path(&r, &r.join("blog/.next/cache/x")));
        assert!(is_ignored_path(&r, &r.join("blog/.env.local")));
        assert!(is_ignored_path(&r, &r.join("blog/.DS_Store")));
        assert!(is_ignored_path(&r, &r.join("blog/dist/main.js")));
        assert!(!is_ignored_path(&r, &r.join("blog/src/index.ts")));
        assert!(!is_ignored_path(&r, &r.join("blog/package.json")));
        // env-like but not .env
        assert!(!is_ignored_path(&r, &r.join("blog/environment.ts")));
    }

    #[test]
    fn classifies_project_lifecycle_events() {
        let r = root();
        let create_kind = EventKind::Create(CreateKind::Folder);
        let create_paths = vec![r.join("portfolio")];
        let remove_kind = EventKind::Remove(RemoveKind::Folder);
        let remove_paths = vec![r.join("old-site")];
        let modify_kind = EventKind::Modify(ModifyKind::Any);
        let modify_paths = vec![r.join("blog/src/app.tsx"), r.join("blog/src/main.tsx")];

        let changes = classify_events(
            &r,
            vec![
                (&create_kind, &create_paths),
                (&remove_kind, &remove_paths),
                (&modify_kind, &modify_paths),
            ]
            .into_iter(),
            |_| true,
        );

        assert_eq!(
            changes,
            vec![
                FsChange { project: "blog".into(), kind: "modified".into() },
                FsChange { project: "old-site".into(), kind: "project-removed".into() },
                FsChange { project: "portfolio".into(), kind: "project-added".into() },
            ]
        );
    }

    #[test]
    fn duplicate_events_collapse_to_one_change() {
        let r = root();
        let kind = EventKind::Modify(ModifyKind::Any);
        let paths = vec![r.join("blog/a.ts"), r.join("blog/b.ts"), r.join("blog/c.ts")];
        let changes = classify_events(&r, vec![(&kind, &paths)].into_iter(), |_| true);
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn move_to_trash_reports_project_removed() {
        // Trash = rename out of the tree: FSEvents says Modify, but the dir
        // is gone. Must classify as removed, never as a deployable change.
        let r = root();
        let kind = EventKind::Modify(ModifyKind::Any);
        let paths = vec![r.join("blog")];
        let changes = classify_events(&r, vec![(&kind, &paths)].into_iter(), |_| false);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "project-removed");
    }

    #[test]
    fn finder_icon_resource_never_triggers_deploys() {
        let r = root();
        // The "Icon\r" file our own folder-status icons write.
        assert!(is_ignored_path(&r, &r.join("blog/Icon\r")));
        let kind = EventKind::Create(CreateKind::File);
        let paths = vec![r.join("blog/Icon\r")];
        assert!(classify_events(&r, vec![(&kind, &paths)].into_iter(), |_| true).is_empty());
    }

    #[test]
    fn metadata_change_on_project_dir_is_not_a_content_change() {
        let r = root();
        // Repainting the folder icon sets xattrs on the project dir itself.
        let meta_kind = EventKind::Modify(ModifyKind::Metadata(
            notify::event::MetadataKind::Extended,
        ));
        let paths = vec![r.join("blog")];
        assert!(classify_events(&r, vec![(&meta_kind, &paths)].into_iter(), |_| true).is_empty());

        // …but a real modify event on the dir (e.g. rename) still surfaces.
        let name_kind = EventKind::Modify(ModifyKind::Any);
        let changes = classify_events(&r, vec![(&name_kind, &paths)].into_iter(), |_| true);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "modified");
    }

    #[test]
    fn hidden_top_level_dirs_are_ignored() {
        let r = root();
        let kind = EventKind::Modify(ModifyKind::Any);
        let paths = vec![r.join(".tmp-copy/file.ts")];
        assert!(classify_events(&r, vec![(&kind, &paths)].into_iter(), |_| true).is_empty());
    }
}
