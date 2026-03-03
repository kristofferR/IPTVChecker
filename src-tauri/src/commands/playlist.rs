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
