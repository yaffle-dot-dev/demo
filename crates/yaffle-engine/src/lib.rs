use yaffle_contracts::{
    DiagnosticLevel, DiagnosticMessage, EngineOperation, EngineResponse, OperationResult,
    OperationResultKind,
};

pub use yaffle_contracts::{EngineError, EnvironmentTarget, WorkspaceSelection, CONTRACT_VERSION};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRequest {
    pub operation: EngineOperation,
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
}

pub fn placeholder_response(request: &EngineRequest, summary: impl Into<String>) -> EngineResponse {
    EngineResponse {
        contract_version: CONTRACT_VERSION,
        operation: request.operation.clone(),
        target: request.target.clone(),
        selection: request.selection.clone(),
        result: OperationResult {
            kind: OperationResultKind::Partial,
            summary: summary.into(),
        },
        environment: None,
        workspaces: Vec::new(),
        outputs: Default::default(),
        diagnostics: vec![DiagnosticMessage {
            level: DiagnosticLevel::Warning,
            code: Some("not_implemented".to_string()),
            message: "This CLI alpha command is not fully implemented yet.".to_string(),
            workspace_path: None,
            item_key: None,
            details: None,
        }],
        metrics: None,
    }
}
