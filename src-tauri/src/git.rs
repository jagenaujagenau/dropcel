use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::watcher::WatcherState;

/// Lightweight git awareness with no dependency on a git binary: branch and
/// commit come from reading `.git` files directly, and in-flight operations
/// (merge/rebase/…) are detected by their marker files so auto-deploys can
/// hold instead of shipping a conflicted working tree.

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub sha: Option<String>,
    /// "merge" | "rebase" | "cherry-pick" | "bisect" while one is in flight.
    pub operation: Option<String>,
}

impl GitInfo {
    fn not_a_repo() -> Self {
        GitInfo { is_repo: false, branch: None, sha: None, operation: None }
    }
}

/// Resolve `.git` to the directory that actually holds `HEAD`.
///
/// For an ordinary clone `.git` *is* that directory. For a linked worktree or
/// a submodule it is a **file** containing `gitdir: <path>`, and treating that
/// as "not a repo" meant `is_repo: false` for both — so the branch lock and
/// the mid-operation hold silently did not apply, and the app would happily
/// auto-deploy a worktree in the middle of a rebase. That is exactly the
/// "broken states are held, not shipped" promise, failing quietly for the
/// users most likely to rely on it.
fn resolve_git_dir(git: &Path) -> Option<PathBuf> {
    if git.is_dir() {
        return Some(git.to_path_buf());
    }
    let contents = std::fs::read_to_string(git).ok()?;
    let target = contents.trim().strip_prefix("gitdir:")?.trim();
    let path = Path::new(target);
    // The recorded path may be relative to the directory holding the `.git`
    // file (git writes relative paths for submodules).
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        git.parent()?.join(path)
    };
    resolved.is_dir().then_some(resolved)
}

pub fn read_git_dir(git: &Path) -> GitInfo {
    let Some(git_dir) = resolve_git_dir(git) else {
        return GitInfo::not_a_repo();
    };
    let git = git_dir.as_path();

    let head_raw = std::fs::read_to_string(git.join("HEAD")).unwrap_or_default();
    let head = head_raw.trim();
    let (branch, sha) = if let Some(reference) = head.strip_prefix("ref: ") {
        let branch = reference.strip_prefix("refs/heads/").map(str::to_string);
        let sha = std::fs::read_to_string(git.join(reference))
            .ok()
            .map(|s| s.trim().to_string())
            .or_else(|| packed_ref_sha(git, reference));
        (branch, sha)
    } else if !head.is_empty() {
        // Detached HEAD: the file holds the sha itself.
        (None, Some(head.to_string()))
    } else {
        (None, None)
    };

    let operation = if git.join("rebase-merge").is_dir() || git.join("rebase-apply").is_dir() {
        Some("rebase")
    } else if git.join("MERGE_HEAD").is_file() {
        Some("merge")
    } else if git.join("CHERRY_PICK_HEAD").is_file() {
        Some("cherry-pick")
    } else if git.join("BISECT_LOG").is_file() {
        Some("bisect")
    } else {
        None
    };

    GitInfo {
        is_repo: true,
        branch,
        sha,
        operation: operation.map(str::to_string),
    }
}

fn packed_ref_sha(git: &Path, reference: &str) -> Option<String> {
    let find = |dir: &Path| -> Option<String> {
        let packed = std::fs::read_to_string(dir.join("packed-refs")).ok()?;
        packed.lines().find_map(|line| {
            let (sha, name) = line.split_once(' ')?;
            (name.trim() == reference).then(|| sha.trim().to_string())
        })
    };
    find(git).or_else(|| {
        // A linked worktree's git dir has no `packed-refs` of its own — refs
        // are shared with the main repository, which `commondir` points at.
        let common = std::fs::read_to_string(git.join("commondir")).ok()?;
        let common = common.trim();
        let path = Path::new(common);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            git.join(path)
        };
        find(&resolved)
    })
}

/// `(async)`: this runs once per project on every structural reconcile, and a
/// plain command body would do all of that `.git` reading on the main thread,
/// where it blocks the webview from painting.
#[tauri::command(async)]
pub fn git_info(state: State<'_, WatcherState>, project: String) -> AppResult<GitInfo> {
    if project.contains(['/', '\\']) || project.starts_with('.') {
        return Err(AppError::Validation(format!("invalid project name: {project}")));
    }
    let root = state.root.lock().unwrap().clone();
    Ok(read_git_dir(&root.join(project).join(".git")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("vercel-folder-git-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn non_repo_reports_not_a_repo() {
        let dir = scratch("plain");
        assert_eq!(read_git_dir(&dir.join(".git")), GitInfo::not_a_repo());
    }

    #[test]
    fn reads_branch_and_sha_from_loose_ref() {
        let git = scratch("loose").join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git.join("refs/heads/main"), "abc123def\n").unwrap();
        let info = read_git_dir(&git);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.sha.as_deref(), Some("abc123def"));
        assert_eq!(info.operation, None);
    }

    #[test]
    fn falls_back_to_packed_refs() {
        let git = scratch("packed").join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        std::fs::write(
            git.join("packed-refs"),
            "# pack-refs with: peeled\nfff000 refs/heads/feature/x\n",
        )
        .unwrap();
        let info = read_git_dir(&git);
        assert_eq!(info.branch.as_deref(), Some("feature/x"));
        assert_eq!(info.sha.as_deref(), Some("fff000"));
    }

    #[test]
    fn detached_head_has_sha_but_no_branch() {
        let git = scratch("detached").join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "abc999\n").unwrap();
        let info = read_git_dir(&git);
        assert_eq!(info.branch, None);
        assert_eq!(info.sha.as_deref(), Some("abc999"));
    }

    /// A linked worktree's `.git` is a *file* pointing at the real git dir.
    /// Reported as "not a repo", the branch lock and the mid-rebase hold both
    /// silently stopped applying — so a worktree could auto-deploy mid-rebase.
    #[test]
    fn worktree_git_file_resolves_to_the_real_git_dir() {
        let root = scratch("worktree");
        // The main repo, with the worktree's private git dir inside it.
        let wt_git = root.join("main/.git/worktrees/feature");
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(wt_git.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        // Refs are shared with the main repo, not stored per-worktree.
        std::fs::write(
            root.join("main/.git/packed-refs"),
            "# pack-refs with: peeled\nabc123 refs/heads/feature/x\n",
        )
        .unwrap();
        // The checkout itself: `.git` is a file, absolute gitdir.
        let checkout = root.join("feature");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", wt_git.display()),
        )
        .unwrap();

        let info = read_git_dir(&checkout.join(".git"));
        assert!(info.is_repo);
        assert_eq!(info.branch.as_deref(), Some("feature/x"));
        // Resolved through `commondir` — the worktree has no packed-refs.
        assert_eq!(info.sha.as_deref(), Some("abc123"));

        // A rebase in the worktree must be seen, so auto-deploys hold.
        std::fs::create_dir_all(wt_git.join("rebase-merge")).unwrap();
        assert_eq!(
            read_git_dir(&checkout.join(".git")).operation.as_deref(),
            Some("rebase")
        );
    }

    /// Submodules use the same mechanism, but git records a *relative* path.
    #[test]
    fn submodule_git_file_with_a_relative_gitdir_resolves() {
        let root = scratch("submodule");
        let real = root.join(".git/modules/lib");
        std::fs::create_dir_all(real.join("refs/heads")).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(real.join("refs/heads/main"), "deadbeef\n").unwrap();

        let sub = root.join("lib");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(".git"), "gitdir: ../.git/modules/lib\n").unwrap();

        let info = read_git_dir(&sub.join(".git"));
        assert!(info.is_repo);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.sha.as_deref(), Some("deadbeef"));
    }

    /// A `.git` file pointing nowhere is still not a repo.
    #[test]
    fn dangling_git_file_is_not_a_repo() {
        let dir = scratch("dangling");
        std::fs::write(dir.join(".git"), "gitdir: /nope/does/not/exist\n").unwrap();
        assert_eq!(read_git_dir(&dir.join(".git")), GitInfo::not_a_repo());
    }

    #[test]
    fn detects_in_flight_operations() {
        let git = scratch("ops").join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        std::fs::write(git.join("MERGE_HEAD"), "abc\n").unwrap();
        assert_eq!(read_git_dir(&git).operation.as_deref(), Some("merge"));
        std::fs::remove_file(git.join("MERGE_HEAD")).unwrap();

        std::fs::create_dir_all(git.join("rebase-merge")).unwrap();
        assert_eq!(read_git_dir(&git).operation.as_deref(), Some("rebase"));
    }
}
