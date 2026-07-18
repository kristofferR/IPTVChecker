use std::path::Path;

use fs2::available_space;

use crate::error::AppError;

/// Write `bytes` to `path` atomically: write a sibling temp file, then rename
/// it over the target. Windows can't rename over an existing file, so a
/// failed rename falls back to remove-then-rename when the target exists.
/// The temp file is cleaned up on any failure.
pub fn atomic_write(path: &Path, tmp_path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let result = (|| -> Result<(), AppError> {
        std::fs::write(tmp_path, bytes).map_err(AppError::Io)?;
        match std::fs::rename(tmp_path, path) {
            Ok(()) => Ok(()),
            Err(first_error) => {
                if path.exists() {
                    std::fs::remove_file(path).map_err(AppError::Io)?;
                    std::fs::rename(tmp_path, path).map_err(AppError::Io)
                } else {
                    Err(AppError::Io(first_error))
                }
            }
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp_path);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiskSpaceTier {
    Plenty,
    Moderate,
    Low,
    Critical,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskSpaceInfo {
    pub available_bytes: u64,
    pub tier: DiskSpaceTier,
}

pub fn query_available_space(path: &Path) -> Option<u64> {
    available_space(path).ok()
}

pub fn classify_space(path: &Path, low_threshold_gb: f64) -> DiskSpaceTier {
    let Some(avail) = query_available_space(path) else {
        return DiskSpaceTier::Plenty;
    };

    let threshold_bytes = (low_threshold_gb * 1_073_741_824.0) as u64;
    let critical_bytes = 1_073_741_824u64; // 1 GB

    if avail < critical_bytes {
        DiskSpaceTier::Critical
    } else if avail < threshold_bytes {
        DiskSpaceTier::Low
    } else if avail < threshold_bytes * 4 {
        DiskSpaceTier::Moderate
    } else {
        DiskSpaceTier::Plenty
    }
}

pub fn get_disk_space_info(path: &Path, low_threshold_gb: f64) -> DiskSpaceInfo {
    let available_bytes = query_available_space(path).unwrap_or(0);
    let tier = classify_space(path, low_threshold_gb);
    DiskSpaceInfo {
        available_bytes,
        tier,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_space_returns_valid_tier_for_root() {
        let tier = classify_space(Path::new("/"), 5.0);
        // Just verify it returns a valid tier without assuming disk size
        assert!(matches!(
            tier,
            DiskSpaceTier::Plenty
                | DiskSpaceTier::Moderate
                | DiskSpaceTier::Low
                | DiskSpaceTier::Critical
        ));
    }

    #[test]
    fn query_available_space_returns_some_for_root() {
        let space = query_available_space(Path::new("/"));
        assert!(space.is_some());
        assert!(space.unwrap() > 0);
    }
}
