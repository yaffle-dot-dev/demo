use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TofuToolchain {
    pub strategy: String,
}

impl Default for TofuToolchain {
    fn default() -> Self {
        Self {
            strategy: "system-or-managed".to_string(),
        }
    }
}
