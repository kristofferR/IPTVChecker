use fancy_regex::Regex as FancyRegex;
use regex::Regex as FastRegex;

use crate::error::AppError;

#[derive(Debug)]
enum SearchPatternMatcher {
    Fast(FastRegex),
    Fancy(FancyRegex),
}

#[derive(Debug)]
pub struct ChannelSearchPattern {
    raw: String,
    matcher: SearchPatternMatcher,
}

impl ChannelSearchPattern {
    pub fn compile(channel_search: &Option<String>) -> Result<Option<Self>, AppError> {
        let Some(search) = channel_search
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };

        let case_insensitive_pattern = format!("(?i){search}");

        if let Ok(regex) = FastRegex::new(&case_insensitive_pattern) {
            return Ok(Some(Self {
                raw: search.to_string(),
                matcher: SearchPatternMatcher::Fast(regex),
            }));
        }

        let regex = FancyRegex::new(&case_insensitive_pattern)
            .map_err(|error| AppError::Parse(format!("Invalid regex '{}': {}", search, error)))?;

        Ok(Some(Self {
            raw: search.to_string(),
            matcher: SearchPatternMatcher::Fancy(regex),
        }))
    }

    pub fn is_match(&self, value: &str) -> Result<bool, AppError> {
        match &self.matcher {
            SearchPatternMatcher::Fast(regex) => Ok(regex.is_match(value)),
            SearchPatternMatcher::Fancy(regex) => regex.is_match(value).map_err(|error| {
                AppError::Parse(format!(
                    "Regex '{}' failed while matching '{}': {}",
                    self.raw, value, error
                ))
            }),
        }
    }
}
