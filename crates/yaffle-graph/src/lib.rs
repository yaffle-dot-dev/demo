use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceNode {
    pub path: String,
    pub dependencies: Vec<String>,
}
