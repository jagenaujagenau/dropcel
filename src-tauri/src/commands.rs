//! Thin IPC wrappers around the SQLite layer and watcher controls.
//! All business decisions (what to deploy, when, state transitions) live in
//! the TypeScript application layer; these commands are deliberately dumb.

use tauri::{AppHandle, Emitter, State};

use crate::db::{Db, Deployment, LogLine, Project, ProjectDomain};
use crate::error::AppResult;
use crate::watcher::{self, WatcherState};

// ---- projects -------------------------------------------------------------

#[tauri::command]
pub fn db_list_projects(db: State<'_, Db>) -> AppResult<Vec<Project>> {
    db.list_projects()
}

#[tauri::command]
pub fn db_upsert_project(
    db: State<'_, Db>,
    name: String,
    path: String,
    framework: String,
) -> AppResult<Project> {
    db.upsert_project(&name, &path, &framework)
}

#[tauri::command]
pub fn db_rename_project(
    db: State<'_, Db>,
    id: String,
    new_name: String,
    new_path: String,
) -> AppResult<()> {
    db.rename_project(&id, &new_name, &new_path)
}

#[tauri::command]
pub fn db_set_project_link(
    db: State<'_, Db>,
    id: String,
    vercel_project_id: Option<String>,
) -> AppResult<()> {
    db.set_project_link(&id, vercel_project_id.as_deref())
}

#[tauri::command]
pub fn db_set_auto_deploy(db: State<'_, Db>, id: String, enabled: bool) -> AppResult<()> {
    db.set_auto_deploy(&id, enabled)
}

#[tauri::command]
pub fn db_set_project_framework(db: State<'_, Db>, id: String, framework: String) -> AppResult<()> {
    db.set_project_framework(&id, &framework)
}

#[tauri::command]
pub fn db_delete_project(db: State<'_, Db>, id: String) -> AppResult<()> {
    db.delete_project(&id)
}

// ---- deployments ----------------------------------------------------------

#[tauri::command]
pub fn db_insert_deployment(
    db: State<'_, Db>,
    project_id: String,
    target: String,
    branch: Option<String>,
    commit_sha: Option<String>,
) -> AppResult<Deployment> {
    db.insert_deployment(&project_id, &target, branch.as_deref(), commit_sha.as_deref())
}

#[tauri::command]
pub fn db_set_remote_repo(db: State<'_, Db>, id: String, repo: String) -> AppResult<()> {
    db.set_remote_repo(&id, &repo)
}

#[tauri::command]
pub fn db_set_locked_branch(
    db: State<'_, Db>,
    id: String,
    branch: Option<String>,
) -> AppResult<()> {
    db.set_locked_branch(&id, branch.as_deref())
}

#[tauri::command]
pub fn db_update_deployment(
    db: State<'_, Db>,
    id: String,
    state: String,
    url: Option<String>,
    error: Option<String>,
    exit_code: Option<i64>,
) -> AppResult<Deployment> {
    db.update_deployment(&id, &state, url.as_deref(), error.as_deref(), exit_code)
}

#[tauri::command]
pub fn db_set_deployment_vercel_ids(
    db: State<'_, Db>,
    id: String,
    vercel_deployment_id: String,
    inspector_url: Option<String>,
) -> AppResult<()> {
    db.set_deployment_vercel_ids(&id, &vercel_deployment_id, inspector_url.as_deref())
}

#[tauri::command]
pub fn db_set_project_team(db: State<'_, Db>, id: String, team_id: Option<String>) -> AppResult<()> {
    db.set_project_team(&id, team_id.as_deref())
}

#[tauri::command]
pub fn db_append_log(
    db: State<'_, Db>,
    deployment_id: String,
    stream: String,
    line: String,
) -> AppResult<()> {
    db.append_log(&deployment_id, &stream, &line)
}

#[tauri::command]
pub fn db_set_deployment_public_url(
    db: State<'_, Db>,
    id: String,
    public_url: String,
) -> AppResult<()> {
    db.set_deployment_public_url(&id, &public_url)
}

#[tauri::command]
pub fn db_list_deployments(
    db: State<'_, Db>,
    project_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<Deployment>> {
    db.list_deployments(&project_id, limit.unwrap_or(50))
}

#[tauri::command]
pub fn db_latest_deployments(db: State<'_, Db>) -> AppResult<Vec<Deployment>> {
    db.latest_deployments()
}

#[tauri::command]
pub fn db_get_logs(db: State<'_, Db>, deployment_id: String) -> AppResult<Vec<LogLine>> {
    db.get_logs(&deployment_id)
}

// ---- domains --------------------------------------------------------------

#[tauri::command]
pub fn db_add_domain(
    db: State<'_, Db>,
    project_id: String,
    domain: String,
    verified: bool,
) -> AppResult<()> {
    db.add_domain(&project_id, &domain, verified)
}

#[tauri::command]
pub fn db_set_domain_verified(db: State<'_, Db>, domain: String, verified: bool) -> AppResult<()> {
    db.set_domain_verified(&domain, verified)
}

#[tauri::command]
pub fn db_remove_domain(db: State<'_, Db>, domain: String) -> AppResult<()> {
    db.remove_domain(&domain)
}

#[tauri::command]
pub fn db_list_domains(db: State<'_, Db>, project_id: String) -> AppResult<Vec<ProjectDomain>> {
    db.list_domains(&project_id)
}

// ---- settings -------------------------------------------------------------

#[tauri::command]
pub fn db_get_setting(db: State<'_, Db>, key: String) -> AppResult<Option<String>> {
    db.get_setting(&key)
}

#[tauri::command]
pub fn db_set_setting(db: State<'_, Db>, key: String, value: String) -> AppResult<()> {
    db.set_setting(&key, &value)
}

// ---- watcher --------------------------------------------------------------

#[tauri::command]
pub fn set_watch_paused(
    app: AppHandle,
    state: State<'_, WatcherState>,
    paused: bool,
) -> AppResult<()> {
    watcher::set_paused(&state, paused);
    let _ = app.emit("watcher:paused", paused);
    Ok(())
}

#[tauri::command]
pub fn get_watch_paused(state: State<'_, WatcherState>) -> bool {
    watcher::is_paused(&state)
}

/// Change the watched root folder and persist the choice.
#[tauri::command]
pub fn set_root_folder(
    app: AppHandle,
    state: State<'_, WatcherState>,
    db: State<'_, Db>,
    path: String,
) -> AppResult<()> {
    let new_root = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&new_root)?;
    *state.root.lock().unwrap() = new_root;
    db.set_setting("root_folder", &path)?;
    watcher::stop(&state);
    watcher::start(app, &state)
}
