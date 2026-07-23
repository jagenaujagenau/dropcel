use std::time::Duration;

/// Real connectivity probe: can we reach Vercel's API endpoint? A TCP
/// connect (no HTTP) is enough to distinguish "on a LAN with no internet"
/// from actually online, which `navigator.onLine` cannot.
#[tauri::command]
pub async fn check_online() -> bool {
    let connect = async {
        let mut addrs = tokio::net::lookup_host("api.vercel.com:443").await.ok()?;
        let addr = addrs.next()?;
        tokio::net::TcpStream::connect(addr).await.ok()
    };
    tokio::time::timeout(Duration::from_secs(4), connect)
        .await
        .ok()
        .flatten()
        .is_some()
}
