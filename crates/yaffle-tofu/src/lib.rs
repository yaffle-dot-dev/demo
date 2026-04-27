use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TofuSourceKind {
    Override,
    Bundled,
    Managed,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TofuVersionRequirement {
    pub pinned_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TofuResolutionPolicy {
    pub preferred_sources: Vec<TofuSourceKind>,
    pub system_fallback_allowed: bool,
}

impl Default for TofuResolutionPolicy {
    fn default() -> Self {
        Self {
            preferred_sources: vec![
                TofuSourceKind::Override,
                TofuSourceKind::Bundled,
                TofuSourceKind::Managed,
                TofuSourceKind::System,
            ],
            system_fallback_allowed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TofuResolution {
    pub source: TofuSourceKind,
    pub path: String,
    pub version: String,
}
