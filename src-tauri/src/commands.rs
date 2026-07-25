//! Thin IPC wrappers around the SQLite layer and watcher controls.
//! All business decisions (what to deploy, when, state transitions) live in
//! the TypeScript application layer; these commands are deliberately dumb.

use tauri::{AppHandle, Emitter, State};

use crate::db::{Account, Db, Deployment, LogLine, Project, ProjectDomain};
use crate::error::AppResult;
use crate::watcher::{self, WatcherState};

/// One forwarder per Db method: `#[tauri::command]` can't sit on an impl, so
/// each line expands to `fn <name>(db, args…) -> AppResult<ret> { db.<method>(fwd…) }`.
/// Argument names are part of the IPC contract — Tauri maps the camelCase
/// keys in src/lib/ipc.ts onto these snake_case names.
///
/// `(async)` rather than a plain `#[tauri::command]`: a sync command body runs
/// on the **main thread**, so the webview cannot paint while it executes.
/// These are SQLite calls behind a mutex — usually microseconds, but
/// `db_append_logs` writes a whole burst of build-log lines, several hundred
/// times over a Next.js build, arriving in bursts every poll. That's a storm
/// of main-thread work landing exactly while the user is watching the card
/// animate. `(async)` keeps each body synchronous and moves it to the async
/// runtime's blocking pool; the bodies hold no lock across an await (there are
/// no awaits), so the futures stay `Send`.
macro_rules! db_command {
    ($name:ident($($arg:ident: $ty:ty),* $(,)?) -> $ret:ty => $method:ident($($fwd:expr),* $(,)?)) => {
        #[tauri::command(async)]
        pub fn $name(db: State<'_, Db>, $($arg: $ty),*) -> AppResult<$ret> {
            db.$method($($fwd),*)
        }
    };
}

// ---- projects -------------------------------------------------------------

db_command!(db_list_projects() -> Vec<Project> => list_projects());
db_command!(db_upsert_project(name: String, path: String, framework: String) -> Project
    => upsert_project(&name, &path, &framework));
db_command!(db_rename_project(id: String, new_name: String, new_path: String) -> ()
    => rename_project(&id, &new_name, &new_path));
db_command!(db_set_project_link(id: String, vercel_project_id: Option<String>) -> ()
    => set_project_link(&id, vercel_project_id.as_deref()));
db_command!(db_set_auto_deploy(id: String, enabled: bool) -> () => set_auto_deploy(&id, enabled));
db_command!(db_set_project_framework(id: String, framework: String) -> ()
    => set_project_framework(&id, &framework));
db_command!(db_claim_unowned_projects(owner_uid: String) -> usize
    => claim_unowned_projects(&owner_uid));
db_command!(db_start_fresh_under(owner_uid: Option<String>) -> usize
    => start_fresh_under(owner_uid.as_deref()));

/// Forget a project locally: its row (deployments, logs and domains cascade)
/// and its snapshot file.
///
/// Not a `db_command!` line because it is deliberately *not* one DB call. The
/// frontend used to sequence the two halves itself — snapshot first with its
/// error swallowed, then the row — so a failure between them orphaned a PNG
/// under a project id nothing referenced any more. Doing both here makes the
/// order fixed and the outcome one result.
///
/// The row goes first: it is the authoritative record, and a leftover image
/// with no row is invisible (the next capture for a reused id overwrites it),
/// whereas a row whose snapshot is already gone renders a broken card.
#[tauri::command(async)]
pub fn forget_project(app: AppHandle, db: State<'_, Db>, project_id: String) -> AppResult<()> {
    db.delete_project(&project_id)?;
    if let Err(err) = crate::screenshot::delete_snapshot_file(&app, &project_id) {
        crate::logger::log(
            &app,
            "WARN",
            "db",
            &format!("could not delete snapshot for {project_id}: {err}"),
        );
    }
    Ok(())
}

// ---- accounts -------------------------------------------------------------

db_command!(db_upsert_account(uid: String, username: String, avatar_url: Option<String>) -> ()
    => upsert_account(&uid, &username, avatar_url.as_deref()));
db_command!(db_list_accounts() -> Vec<Account> => list_accounts());

// ---- deployments ----------------------------------------------------------

db_command!(db_insert_deployment(
    project_id: String,
    target: String,
    branch: Option<String>,
    commit_sha: Option<String>,
) -> Deployment
    => insert_deployment(&project_id, &target, branch.as_deref(), commit_sha.as_deref()));
db_command!(db_set_remote_repo(id: String, repo: String) -> () => set_remote_repo(&id, &repo));
db_command!(db_set_locked_branch(id: String, branch: Option<String>) -> ()
    => set_locked_branch(&id, branch.as_deref()));
db_command!(db_update_deployment(
    id: String,
    state: String,
    url: Option<String>,
    error: Option<String>,
    exit_code: Option<i64>,
) -> Deployment
    => update_deployment(&id, &state, url.as_deref(), error.as_deref(), exit_code));
db_command!(db_set_deployment_vercel_ids(
    id: String,
    vercel_deployment_id: String,
    inspector_url: Option<String>,
) -> ()
    => set_deployment_vercel_ids(&id, &vercel_deployment_id, inspector_url.as_deref()));
db_command!(db_set_project_team(id: String, team_id: Option<String>) -> ()
    => set_project_team(&id, team_id.as_deref()));
db_command!(db_append_logs(deployment_id: String, lines: Vec<(String, String)>) -> ()
    => append_logs(&deployment_id, &lines));
db_command!(db_set_deployment_public_url(id: String, public_url: String) -> ()
    => set_deployment_public_url(&id, &public_url));
db_command!(db_list_deployments(project_id: String, limit: Option<i64>) -> Vec<Deployment>
    => list_deployments(&project_id, limit.unwrap_or(50)));
db_command!(db_latest_deployments() -> Vec<Deployment> => latest_deployments());
db_command!(db_get_logs(deployment_id: String, tail: Option<i64>) -> Vec<LogLine>
    => get_logs(&deployment_id, tail));

// ---- domains --------------------------------------------------------------

db_command!(db_add_domain(project_id: String, domain: String, verified: bool) -> ()
    => add_domain(&project_id, &domain, verified));
db_command!(db_set_domain_verified(domain: String, verified: bool) -> ()
    => set_domain_verified(&domain, verified));
db_command!(db_remove_domain(domain: String) -> () => remove_domain(&domain));
db_command!(db_list_domains(project_id: String) -> Vec<ProjectDomain> => list_domains(&project_id));

// ---- settings -------------------------------------------------------------

db_command!(db_get_setting(key: String) -> Option<String> => get_setting(&key));
db_command!(db_set_setting(key: String, value: String) -> () => set_setting(&key, &value));

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
