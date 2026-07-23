use serde::Serialize;

/// Application error surfaced to the frontend as a structured, actionable payload.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("watcher error: {0}")]
    Watch(String),
    #[error("keychain error: {0}")]
    Keychain(String),
    /// Caller sent something we refuse to act on (bad name, escaping path).
    #[error("{0}")]
    Validation(String),
    /// The referenced project/file no longer exists.
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Message(String),
}

#[derive(Serialize)]
struct ErrorPayload {
    kind: &'static str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Watch(_) => "watch",
            AppError::Keychain(_) => "keychain",
            AppError::Validation(_) => "validation",
            AppError::NotFound(_) => "not-found",
            AppError::Message(_) => "message",
        };
        ErrorPayload {
            kind,
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;
