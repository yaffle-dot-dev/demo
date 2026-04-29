use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONTRACT_VERSION: u16 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EngineOperation {
    Converge,
    Destroy,
    Status,
    Wait,
    Outputs,
    Graph,
    Doctor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationResultKind {
    Succeeded,
    Degraded,
    Blocked,
    Failed,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationResult {
    pub kind: OperationResultKind,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiagnosticMessage {
    pub level: DiagnosticLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerraformOutput {
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvironmentSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Value>,
    pub conditions: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materialization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceSnapshot {
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materialization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineResponse {
    pub contract_version: u16,
    pub operation: EngineOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
    pub result: OperationResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<EnvironmentSnapshot>,
    pub workspaces: Vec<WorkspaceSnapshot>,
    pub outputs: BTreeMap<String, TerraformOutput>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workspace_outputs: BTreeMap<String, BTreeMap<String, TerraformOutput>>,
    pub diagnostics: Vec<DiagnosticMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<EngineMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineError {
    pub contract_version: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<EngineOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<EnvironmentTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<WorkspaceSelection>,
    pub error: ErrorPayload,
}
