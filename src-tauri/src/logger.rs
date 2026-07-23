use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

use crate::error::AppResult;

/// Structured app log: one greppable line per event,
/// `2026-07-23T10:00:00Z WARN  queue      cannot deploy unknown project x`.
/// Both layers write here — Rust directly, the frontend via `log_event` —
/// so "why didn't it deploy?" has one place to look. Size-rotated once.
pub struct Logger {
    path: Mutex<PathBuf>,
}

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const LEVELS: &[&str] = &["info", "warn", "error"];

impl Logger {
    pub fn new(dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Logger {
            path: Mutex::new(dir.join("dropcel.log")),
        })
    }

    pub fn path(&self) -> PathBuf {
        self.path.lock().unwrap().clone()
    }

    pub fn write(&self, level: &str, scope: &str, message: &str) {
        let level = if LEVELS.contains(&level) { level } else { "info" };
        let path = self.path();
        // Rotate: keep exactly one previous generation.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_BYTES {
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
        }
        let line = format!(
            "{} {:5} {:<12} {}\n",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level.to_uppercase(),
            scope,
            message.replace('\n', " ⏎ "),
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Log via the managed Logger from anywhere in the Rust side.
pub fn log(app: &tauri::AppHandle, level: &str, scope: &str, message: &str) {
    if let Some(logger) = app.try_state::<Logger>() {
        logger.write(level, scope, message);
    }
}

#[tauri::command]
pub fn log_event(
    logger: tauri::State<'_, Logger>,
    level: String,
    scope: String,
    message: String,
) {
    logger.write(&level, &scope, &message);
}

#[tauri::command]
pub fn get_log_path(logger: tauri::State<'_, Logger>) -> String {
    logger.path().to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("dropcel-logger-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_structured_lines() {
        let logger = Logger::new(scratch("write")).unwrap();
        logger.write("warn", "queue", "cannot deploy unknown project x");
        logger.write("bogus-level", "a", "multi\nline");
        let content = std::fs::read_to_string(logger.path()).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("WARN"));
        assert!(lines[0].contains("queue"));
        assert!(lines[0].contains("cannot deploy unknown project x"));
        // Unknown level coerces to INFO; newlines are flattened.
        assert!(lines[1].contains("INFO"));
        assert!(lines[1].contains("multi ⏎ line"));
    }

    #[test]
    fn rotates_when_large() {
        let logger = Logger::new(scratch("rotate")).unwrap();
        let big = "x".repeat(1024);
        // Fill past the limit quickly by writing directly.
        for _ in 0..(MAX_BYTES / 1024 + 2) {
            logger.write("info", "fill", &big);
        }
        logger.write("info", "after", "rotated");
        assert!(logger.path().with_extension("log.1").exists());
    }
}
