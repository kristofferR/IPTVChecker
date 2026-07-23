use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Scan cancelled")]
    Cancelled,

    #[error("ffmpeg/ffprobe not available")]
    FfmpegNotAvailable,

    /// User-supplied input failed validation (bad URL, out-of-range setting).
    #[error("{0}")]
    Validation(String),

    /// The operation conflicts with current app state (e.g. a scan is
    /// already running). Not a failure of the operation itself.
    #[error("{0}")]
    State(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
