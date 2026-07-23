use keyring::Entry;
use serde::Serialize;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "app.vercelfolder.desktop";
const ACCOUNT: &str = "vercel-token";
const REFRESH_ACCOUNT: &str = "vercel-refresh-token";

fn entry_for(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(|e| AppError::Keychain(e.to_string()))
}

fn entry() -> AppResult<Entry> {
    entry_for(ACCOUNT)
}

#[tauri::command]
pub fn get_vercel_token() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

#[tauri::command]
pub fn set_vercel_token(token: String) -> AppResult<()> {
    entry()?
        .set_password(&token)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn delete_vercel_token() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

// ---- OAuth refresh token (imported CLI sessions rotate) --------------------

#[tauri::command]
pub fn get_vercel_refresh_token() -> AppResult<Option<String>> {
    match entry_for(REFRESH_ACCOUNT)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

#[tauri::command]
pub fn set_vercel_refresh_token(token: String) -> AppResult<()> {
    entry_for(REFRESH_ACCOUNT)?
        .set_password(&token)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

#[tauri::command]
pub fn delete_vercel_refresh_token() -> AppResult<()> {
    match entry_for(REFRESH_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

// ---- Vercel CLI session detection -----------------------------------------
//
// The Vercel CLI stores its session token in an auth.json under a per-OS
// config dir. If the user is already logged in there, we can import that
// token instead of making them create one — the app itself never runs the
// CLI, it just reads the file.

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliToken {
    pub token: String,
    /// OAuth refresh token, when the CLI session is OAuth-based.
    pub refresh_token: Option<String>,
    /// Access-token expiry (ms since epoch), when known.
    pub expires_at_ms: Option<i64>,
    /// Where it was found, for display ("imported from the Vercel CLI").
    pub path: String,
}

pub fn parse_auth_json(raw: &str, path: &str) -> Option<CliToken> {
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = json.get("token")?.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    Some(CliToken {
        token: token.to_string(),
        refresh_token: json
            .get("refreshToken")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        expires_at_ms: json.get("expiresAt").and_then(|v| v.as_i64()),
        path: path.to_string(),
    })
}

fn auth_json_candidates() -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    out.push(home.join("Library/Application Support/com.vercel.cli/auth.json"));
    if let Some(config) = dirs::config_dir() {
        out.push(config.join("com.vercel.cli/auth.json"));
    }
    if let Some(data) = dirs::data_dir() {
        out.push(data.join("com.vercel.cli/auth.json"));
    }
    out.push(home.join(".config/com.vercel.cli/auth.json"));
    out.push(home.join(".local/share/com.vercel.cli/auth.json"));
    // Legacy locations (older CLI / now-cli).
    out.push(home.join(".vercel/auth.json"));
    out.push(home.join(".now/auth.json"));
    out
}

#[tauri::command]
pub fn detect_cli_token() -> Option<CliToken> {
    for path in auth_json_candidates() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(token) = parse_auth_json(&raw, &path.to_string_lossy()) {
                return Some(token);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_auth_json_with_refresh_fields() {
        let parsed = parse_auth_json(
            r#"{"// Note":"...","token":"abc123","refreshToken":"rt_9","expiresAt":1753280000000}"#,
            "/x/auth.json",
        )
        .unwrap();
        assert_eq!(parsed.token, "abc123");
        assert_eq!(parsed.refresh_token.as_deref(), Some("rt_9"));
        assert_eq!(parsed.expires_at_ms, Some(1_753_280_000_000));
    }

    #[test]
    fn parses_legacy_token_only_files() {
        let parsed = parse_auth_json(r#"{"token":"abc123"}"#, "/x/auth.json").unwrap();
        assert_eq!(parsed.token, "abc123");
        assert_eq!(parsed.refresh_token, None);
        assert_eq!(parsed.expires_at_ms, None);
    }

    #[test]
    fn rejects_missing_or_empty_tokens() {
        assert!(parse_auth_json(r#"{}"#, "p").is_none());
        assert!(parse_auth_json(r#"{"token":""}"#, "p").is_none());
        assert!(parse_auth_json("not json", "p").is_none());
    }
}
