use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// All persistent state lives in SQLite. The frontend never touches the file
/// directly — it goes through the typed commands below so the schema can
/// evolve without breaking the UI.
pub struct Db(pub Mutex<Connection>);

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        framework TEXT NOT NULL DEFAULT 'unknown',
        vercel_project_id TEXT,
        auto_deploy INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'preview',
        url TEXT,
        error TEXT,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS deployment_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        stream TEXT NOT NULL,
        line TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_deployment ON deployment_logs(deployment_id, id);
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    // v2 — custom domains assigned to a project from the app
    "CREATE TABLE IF NOT EXISTS project_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain TEXT NOT NULL UNIQUE,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_domains_project ON project_domains(project_id);",
    // v3 — deployments keep both URLs: the unique per-deployment URL (`url`)
    // and the resolved public alias (`public_url`).
    "ALTER TABLE deployments ADD COLUMN public_url TEXT;",
    // v4 — git awareness: what was deployed (branch/sha at deploy time) and
    // the opt-in per-project branch lock for auto-deploys.
    "ALTER TABLE deployments ADD COLUMN branch TEXT;
     ALTER TABLE deployments ADD COLUMN commit_sha TEXT;
     ALTER TABLE projects ADD COLUMN locked_branch TEXT;",
    // v5 — remote git integration: NULL = never checked, '' = checked and
    // not connected, otherwise the connected repo slug (github.com/x/y).
    "ALTER TABLE projects ADD COLUMN remote_repo TEXT;",
    // v6 — REST API migration: Vercel's own deployment id + inspector URL,
    // and the owning team per project (for teamId-scoped API calls).
    "ALTER TABLE deployments ADD COLUMN vercel_deployment_id TEXT;
     ALTER TABLE deployments ADD COLUMN inspector_url TEXT;
     ALTER TABLE projects ADD COLUMN team_id TEXT;",
];

pub fn open(db_path: &Path) -> AppResult<Db> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(Db(Mutex::new(conn)))
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Db> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(Db(Mutex::new(conn)))
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, migration) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            conn.execute_batch(migration)?;
            conn.pragma_update(None, "user_version", target)?;
        }
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub framework: String,
    pub vercel_project_id: Option<String>,
    pub auto_deploy: bool,
    pub created_at: String,
    pub updated_at: String,
    /// When set, auto-deploys only run while the repo is on this branch.
    pub locked_branch: Option<String>,
    /// Vercel Git integration: None = unchecked, "" = none, else repo slug.
    pub remote_repo: Option<String>,
    /// Owning team id (team_…) for API scoping; None = personal scope.
    pub team_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub id: String,
    pub project_id: String,
    pub state: String,
    pub target: String,
    pub url: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub public_url: Option<String>,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    /// Vercel's own deployment id (dpl_…) once the API created it.
    pub vercel_deployment_id: Option<String>,
    pub inspector_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDomain {
    pub id: i64,
    pub project_id: String,
    pub domain: String,
    pub verified: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub id: i64,
    pub deployment_id: String,
    pub ts: String,
    pub stream: String,
    pub line: String,
}

fn row_to_project(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        path: r.get(2)?,
        framework: r.get(3)?,
        vercel_project_id: r.get(4)?,
        auto_deploy: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        locked_branch: r.get(8)?,
        remote_repo: r.get(9)?,
        team_id: r.get(10)?,
    })
}

fn row_to_deployment(r: &rusqlite::Row) -> rusqlite::Result<Deployment> {
    Ok(Deployment {
        id: r.get(0)?,
        project_id: r.get(1)?,
        state: r.get(2)?,
        target: r.get(3)?,
        url: r.get(4)?,
        error: r.get(5)?,
        exit_code: r.get(6)?,
        started_at: r.get(7)?,
        finished_at: r.get(8)?,
        duration_ms: r.get(9)?,
        public_url: r.get(10)?,
        branch: r.get(11)?,
        commit_sha: r.get(12)?,
        vercel_deployment_id: r.get(13)?,
        inspector_url: r.get(14)?,
    })
}

const PROJECT_COLS: &str =
    "id, name, path, framework, vercel_project_id, auto_deploy, created_at, updated_at, locked_branch, remote_repo, team_id";
const DEPLOYMENT_COLS: &str =
    "id, project_id, state, target, url, error, exit_code, started_at, finished_at, duration_ms, public_url, branch, commit_sha, vercel_deployment_id, inspector_url";

impl Db {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().expect("db mutex poisoned")
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare(&format!("SELECT {PROJECT_COLS} FROM projects ORDER BY name"))?;
        let rows = stmt.query_map([], row_to_project)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Insert a project or, when a project with the same name exists, update its
    /// mutable fields. Renames are handled by the caller via `rename_project`
    /// so the Vercel link survives.
    pub fn upsert_project(
        &self,
        name: &str,
        path: &str,
        framework: &str,
    ) -> AppResult<Project> {
        let conn = self.conn();
        let ts = now();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO projects (id, name, path, framework, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(name) DO UPDATE SET path = ?3, framework = ?4, updated_at = ?5",
            params![id, name, path, framework, ts],
        )?;
        let project = conn.query_row(
            &format!("SELECT {PROJECT_COLS} FROM projects WHERE name = ?1"),
            params![name],
            row_to_project,
        )?;
        Ok(project)
    }

    pub fn rename_project(&self, id: &str, new_name: &str, new_path: &str) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET name = ?2, path = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, new_name, new_path, now()],
        )?;
        Ok(())
    }

    pub fn set_project_link(&self, id: &str, vercel_project_id: Option<&str>) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET vercel_project_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, vercel_project_id, now()],
        )?;
        Ok(())
    }

    pub fn set_deployment_vercel_ids(
        &self,
        id: &str,
        vercel_deployment_id: &str,
        inspector_url: Option<&str>,
    ) -> AppResult<()> {
        self.conn().execute(
            "UPDATE deployments SET vercel_deployment_id = ?2, inspector_url = ?3 WHERE id = ?1",
            params![id, vercel_deployment_id, inspector_url],
        )?;
        Ok(())
    }

    pub fn set_project_team(&self, id: &str, team_id: Option<&str>) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET team_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, team_id, now()],
        )?;
        Ok(())
    }

    pub fn set_remote_repo(&self, id: &str, repo: &str) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET remote_repo = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, repo, now()],
        )?;
        Ok(())
    }

    pub fn set_locked_branch(&self, id: &str, branch: Option<&str>) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET locked_branch = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, branch, now()],
        )?;
        Ok(())
    }

    pub fn set_auto_deploy(&self, id: &str, enabled: bool) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET auto_deploy = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, enabled as i64, now()],
        )?;
        Ok(())
    }

    pub fn set_project_framework(&self, id: &str, framework: &str) -> AppResult<()> {
        self.conn().execute(
            "UPDATE projects SET framework = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, framework, now()],
        )?;
        Ok(())
    }

    /// Removing a project only forgets local state; the remote Vercel project
    /// is never touched.
    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.conn()
            .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn insert_deployment(
        &self,
        project_id: &str,
        target: &str,
        branch: Option<&str>,
        commit_sha: Option<&str>,
    ) -> AppResult<Deployment> {
        let conn = self.conn();
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now();
        conn.execute(
            "INSERT INTO deployments (id, project_id, state, target, started_at, branch, commit_sha)
             VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?6)",
            params![id, project_id, target, ts, branch, commit_sha],
        )?;
        let dep = conn.query_row(
            &format!("SELECT {DEPLOYMENT_COLS} FROM deployments WHERE id = ?1"),
            params![id],
            row_to_deployment,
        )?;
        Ok(dep)
    }

    pub fn update_deployment(
        &self,
        id: &str,
        state: &str,
        url: Option<&str>,
        error: Option<&str>,
        exit_code: Option<i64>,
    ) -> AppResult<Deployment> {
        let conn = self.conn();
        let terminal = matches!(state, "ready" | "failed" | "canceled");
        if terminal {
            conn.execute(
                "UPDATE deployments SET state = ?2,
                    url = COALESCE(?3, url),
                    error = ?4,
                    exit_code = ?5,
                    finished_at = ?6,
                    duration_ms = CAST((julianday(?6) - julianday(started_at)) * 86400000 AS INTEGER)
                 WHERE id = ?1",
                params![id, state, url, error, exit_code, now()],
            )?;
        } else {
            conn.execute(
                "UPDATE deployments SET state = ?2, url = COALESCE(?3, url) WHERE id = ?1",
                params![id, state, url],
            )?;
        }
        let dep = conn.query_row(
            &format!("SELECT {DEPLOYMENT_COLS} FROM deployments WHERE id = ?1"),
            params![id],
            row_to_deployment,
        )?;
        Ok(dep)
    }

    /// Record the resolved public URL after a deployment is ready, without
    /// touching the deployment URL or finished_at/duration.
    pub fn set_deployment_public_url(&self, id: &str, public_url: &str) -> AppResult<()> {
        self.conn().execute(
            "UPDATE deployments SET public_url = ?2 WHERE id = ?1",
            params![id, public_url],
        )?;
        Ok(())
    }

    pub fn list_deployments(&self, project_id: &str, limit: i64) -> AppResult<Vec<Deployment>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DEPLOYMENT_COLS} FROM deployments
             WHERE project_id = ?1 ORDER BY started_at DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![project_id, limit], row_to_deployment)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn latest_deployments(&self) -> AppResult<Vec<Deployment>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DEPLOYMENT_COLS} FROM deployments d
             WHERE started_at = (SELECT MAX(started_at) FROM deployments WHERE project_id = d.project_id)"
        ))?;
        let rows = stmt.query_map([], row_to_deployment)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn append_log(&self, deployment_id: &str, stream: &str, line: &str) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO deployment_logs (deployment_id, ts, stream, line) VALUES (?1, ?2, ?3, ?4)",
            params![deployment_id, now(), stream, line],
        )?;
        Ok(())
    }

    pub fn get_logs(&self, deployment_id: &str) -> AppResult<Vec<LogLine>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, deployment_id, ts, stream, line FROM deployment_logs
             WHERE deployment_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![deployment_id], |r| {
            Ok(LogLine {
                id: r.get(0)?,
                deployment_id: r.get(1)?,
                ts: r.get(2)?,
                stream: r.get(3)?,
                line: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn add_domain(&self, project_id: &str, domain: &str, verified: bool) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO project_domains (project_id, domain, verified, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(domain) DO UPDATE SET project_id = ?1, verified = ?3",
            params![project_id, domain, verified as i64, now()],
        )?;
        Ok(())
    }

    pub fn set_domain_verified(&self, domain: &str, verified: bool) -> AppResult<()> {
        self.conn().execute(
            "UPDATE project_domains SET verified = ?2 WHERE domain = ?1",
            params![domain, verified as i64],
        )?;
        Ok(())
    }

    pub fn remove_domain(&self, domain: &str) -> AppResult<()> {
        self.conn()
            .execute("DELETE FROM project_domains WHERE domain = ?1", params![domain])?;
        Ok(())
    }

    pub fn list_domains(&self, project_id: &str) -> AppResult<Vec<ProjectDomain>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, domain, verified, created_at
             FROM project_domains WHERE project_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(ProjectDomain {
                id: r.get(0)?,
                project_id: r.get(1)?,
                domain: r.get(2)?,
                verified: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn find_project_by_name(&self, name: &str) -> AppResult<Option<Project>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare(&format!("SELECT {PROJECT_COLS} FROM projects WHERE name = ?1"))?;
        let mut rows = stmt.query(params![name])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_project(row).map_err(crate::error::AppError::Db)?)),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_and_crud_roundtrip() {
        let db = open_in_memory().unwrap();
        let p = db.upsert_project("blog", "/tmp/Vercel/blog", "nextjs").unwrap();
        assert_eq!(p.name, "blog");
        assert!(p.auto_deploy);

        // Upsert by name keeps the same id (the Vercel link survives).
        let p2 = db.upsert_project("blog", "/tmp/Vercel/blog", "astro").unwrap();
        assert_eq!(p.id, p2.id);
        assert_eq!(p2.framework, "astro");

        let d = db
            .insert_deployment(&p.id, "preview", Some("main"), Some("abc123"))
            .unwrap();
        assert_eq!(d.state, "queued");
        assert_eq!(d.branch.as_deref(), Some("main"));
        db.append_log(&d.id, "stdout", "Uploading...").unwrap();
        let done = db
            .update_deployment(&d.id, "ready", Some("https://blog.vercel.app"), None, Some(0))
            .unwrap();
        assert_eq!(done.state, "ready");
        assert!(done.duration_ms.is_some());
        assert_eq!(db.get_logs(&d.id).unwrap().len(), 1);
        assert_eq!(db.latest_deployments().unwrap().len(), 1);

        db.set_setting("theme", "dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("dark"));

        db.delete_project(&p.id).unwrap();
        assert!(db.list_projects().unwrap().is_empty());
        // cascade removed deployments
        assert!(db.list_deployments(&p.id, 10).unwrap().is_empty());
    }

    #[test]
    fn domains_crud_and_cascade() {
        let db = open_in_memory().unwrap();
        let p = db.upsert_project("shop", "/tmp/Vercel/shop", "nextjs").unwrap();
        db.add_domain(&p.id, "shop.com", false).unwrap();
        // Re-adding after verification upserts, not duplicates.
        db.add_domain(&p.id, "shop.com", true).unwrap();
        let domains = db.list_domains(&p.id).unwrap();
        assert_eq!(domains.len(), 1);
        assert!(domains[0].verified);

        db.set_domain_verified("shop.com", false).unwrap();
        assert!(!db.list_domains(&p.id).unwrap()[0].verified);

        db.delete_project(&p.id).unwrap();
        assert!(db.list_domains(&p.id).unwrap().is_empty());
    }

    #[test]
    fn rename_preserves_link() {
        let db = open_in_memory().unwrap();
        let p = db.upsert_project("old", "/tmp/Vercel/old", "vite").unwrap();
        db.set_project_link(&p.id, Some("prj_123")).unwrap();
        db.rename_project(&p.id, "new", "/tmp/Vercel/new").unwrap();
        let found = db.find_project_by_name("new").unwrap().unwrap();
        assert_eq!(found.id, p.id);
        assert_eq!(found.vercel_project_id.as_deref(), Some("prj_123"));
    }
}
