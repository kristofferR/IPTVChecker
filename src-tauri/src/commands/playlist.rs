use crate::engine::parser;
use crate::error::AppError;
use crate::models::playlist::PlaylistPreview;

#[tauri::command]
pub async fn open_playlist(
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let path_ref = std::path::Path::new(&path);

    if path_ref.is_dir() {
        let files = parser::find_playlists_in_dir(&path)?;
        if files.is_empty() {
            return Err(AppError::FileNotFound(
                "No .m3u/.m3u8 files found in directory".to_string(),
            ));
        }
        // Parse first playlist for preview; full directory mode handled by scan
        parser::parse_playlist(&files[0], &group_filter, &channel_search)
    } else {
        parser::parse_playlist(&path, &group_filter, &channel_search)
    }
}

#[tauri::command]
pub async fn open_playlist_url(
    url: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let trimmed = url.trim();
    let parsed = url::Url::parse(trimmed)
        .map_err(|error| AppError::Parse(format!("Invalid playlist URL: {}", error)))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Parse(
            "Playlist URL must use http:// or https://".to_string(),
        ));
    }

    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(AppError::Http)?
        .get(parsed.clone())
        .header(reqwest::header::USER_AGENT, "IPTV-Checker-GUI/1.0")
        .send()
        .await
        .map_err(AppError::Http)?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "Failed to download playlist URL: HTTP {}",
            status
        )));
    }

    let bytes = response.bytes().await.map_err(AppError::Http)?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = std::env::temp_dir().join(format!("iptv-url-{unique}.m3u8"));

    std::fs::write(&temp_path, &bytes).map_err(AppError::Io)?;
    parser::parse_playlist(
        &temp_path.to_string_lossy(),
        &group_filter,
        &channel_search,
    )
}
