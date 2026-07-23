use std::path::Path;

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

pub fn read_git_dir(git: &Path) -> GitInfo {
    if !git.is_dir() {
        return GitInfo::not_a_repo();
    }

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
    let packed = std::fs::read_to_string(git.join("packed-refs")).ok()?;
    packed.lines().find_map(|line| {
        let (sha, name) = line.split_once(' ')?;
        (name.trim() == reference).then(|| sha.trim().to_string())
    })
}

#[tauri::command]
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
