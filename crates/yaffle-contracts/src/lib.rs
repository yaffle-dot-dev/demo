use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContractVersion {
    pub major: u16,
}

impl Default for ContractVersion {
    fn default() -> Self {
        Self { major: 1 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentTarget {
    pub environment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct WorkspaceSelection {
    pub workspaces: Vec<String>,
}

impl WorkspaceSelection {
    pub fn is_empty(&self) -> bool {
        self.workspaces.is_empty()
    }
}
