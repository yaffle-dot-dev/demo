use serde::{Deserialize, Serialize};

use yaffle_contracts::{ContractVersion, EnvironmentTarget, WorkspaceSelection};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EngineOperation {
    Converge,
    Destroy,
    Status,
    Outputs,
    Graph,
    Doctor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineRequest {
    pub contract_version: ContractVersion,
    pub operation: EngineOperation,
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineResponse {
    pub contract_version: ContractVersion,
    pub operation: EngineOperation,
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
    pub summary: String,
}

pub fn placeholder_response(request: &EngineRequest, summary: impl Into<String>) -> EngineResponse {
    EngineResponse {
        contract_version: request.contract_version,
        operation: request.operation.clone(),
        target: request.target.clone(),
        selection: request.selection.clone(),
        summary: summary.into(),
    }
}
