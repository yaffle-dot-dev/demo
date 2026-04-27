use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use hcl::Body;
use serde::Deserialize;
use serde_json::{json, Value};
use yaffle_contracts::{
    DiagnosticLevel, DiagnosticMessage, EngineOperation, EngineResponse, OperationResult,
    OperationResultKind, TerraformOutput, WorkspaceSnapshot,
};
use yaffle_graph::{
    apply_workspace_selection, resolve_workspace_graph, EnvironmentKind, GraphError,
    ResolvedWorkspaceGraph, WorkspaceGraphOptions,
};
use yaffle_tofu::{inspect_tofu_resolution, TofuResolutionRequest, TofuSourceKind};

use yaffle_config::{parse_yaffle_toml, validate_environment_name, YaffleConfig};
pub use yaffle_contracts::{EngineError, EnvironmentTarget, WorkspaceSelection, CONTRACT_VERSION};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRequest {
    pub operation: EngineOperation,
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
    pub wait_for: Option<String>,
}

#[derive(Debug, Clone)]
struct RepoContext {
    repo_root: PathBuf,
    config_path: PathBuf,
    config: YaffleConfig,
    current_namespace: Option<String>,
}

#[derive(Debug, Clone)]
struct GraphContext {
    graph: ResolvedWorkspaceGraph,
    topological_order: Vec<String>,
}

#[derive(Debug)]
struct PreparedExecutionRepo {
    _temp_dir: tempfile::TempDir,
    repo_root: PathBuf,
    tf_data_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct RawTerraformOutput {
    value: Value,
    #[serde(rename = "type")]
    type_name: Option<Value>,
    sensitive: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionMode {
    Any,
    None,
    ExactlyOne,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OperationPolicy {
    requires_target: bool,
    requires_repo_context: bool,
    selection_mode: SelectionMode,
}

pub fn execute(request: &EngineRequest, working_dir: &Path) -> Result<EngineResponse, EngineError> {
    validate_request(request)?;

    let policy = operation_policy(&request.operation);
    let repo_context = if policy.requires_repo_context {
        Some(load_repo_context(working_dir, request)?)
    } else {
        None
    };

    match request.operation {
        EngineOperation::Graph => execute_graph_operation(
            request,
            repo_context
                .as_ref()
                .expect("graph execution should always have repo context"),
        ),
        EngineOperation::Converge => execute_converge_operation(
            request,
            repo_context
                .as_ref()
                .expect("converge execution should always have repo context"),
        ),
        EngineOperation::Outputs => execute_outputs_operation(
            request,
            repo_context
                .as_ref()
                .expect("outputs execution should always have repo context"),
        ),
        EngineOperation::Doctor => Ok(execute_doctor_operation(request, working_dir)),
        EngineOperation::Destroy | EngineOperation::Status | EngineOperation::Wait => Ok(
            execute_placeholder_operation(request, repo_context.as_ref()),
        ),
    }
}

fn execute_graph_operation(
    request: &EngineRequest,
    repo_context: &RepoContext,
) -> Result<EngineResponse, EngineError> {
    let graph_context = load_graph_context(repo_context, request)?;
    let mut diagnostics = repo_context_diagnostics(repo_context);
    let dependents = build_dependents(&graph_context.graph);

    let workspace_snapshots = graph_context
        .topological_order
        .iter()
        .map(|workspace_path| WorkspaceSnapshot {
            workspace_path: workspace_path.clone(),
            lifecycle: None,
            materialization: None,
            freshness: None,
        })
        .collect();

    for (index, workspace_path) in graph_context.topological_order.iter().enumerate() {
        let node = graph_context
            .graph
            .workspace(workspace_path)
            .expect("ordered workspace should exist in resolved graph");

        diagnostics.push(DiagnosticMessage {
            level: DiagnosticLevel::Info,
            code: Some("graph_node".to_string()),
            message: format!("Resolved graph node '{}'.", workspace_path),
            workspace_path: Some(workspace_path.clone()),
            item_key: None,
            details: Some(BTreeMap::from([
                ("dependencies".to_string(), json!(node.dependencies)),
                (
                    "dependents".to_string(),
                    json!(dependents.get(workspace_path).cloned().unwrap_or_default()),
                ),
                ("topological_index".to_string(), json!(index)),
            ])),
        });
    }

    Ok(build_response(
        request,
        OperationResultKind::Succeeded,
        format_graph_summary(&graph_context.graph, &graph_context.topological_order),
        workspace_snapshots,
        BTreeMap::new(),
        diagnostics,
    ))
}

fn execute_outputs_operation(
    request: &EngineRequest,
    repo_context: &RepoContext,
) -> Result<EngineResponse, EngineError> {
    let graph_context = load_graph_context(repo_context, request)?;
    let workspace_path = request
        .selection
        .workspaces
        .first()
        .cloned()
        .expect("outputs execution should have exactly one workspace selection");

    let tofu_report = inspect_tofu_resolution(&TofuResolutionRequest::default());
    let tofu_resolution = tofu_report.clone().into_result().map_err(|error| {
        request_error_with_details(
            request,
            "tofu_resolution_failed",
            "could not resolve tofu using the configured source policy",
            Some(BTreeMap::from([(
                "attempts".to_string(),
                json!(error.attempts),
            )])),
        )
    })?;

    let prepared_repo = prepare_execution_repo(&repo_context.repo_root, &workspace_path, request)?;
    let environment_kind = graph_context
        .graph
        .environment_kind
        .expect("outputs operation should have an environment kind");
    let workspace_config = repo_context
        .config
        .workspaces
        .iter()
        .find(|workspace| workspace.path == workspace_path)
        .expect("selected outputs workspace should exist in config");

    let _uses_local_backend =
        configure_workspace_execution(request, &prepared_repo, workspace_config, environment_kind)?;

    run_tofu_command(
        request,
        &tofu_resolution,
        &prepared_repo,
        &workspace_path,
        &["init", "-input=false", "-no-color"],
        "tofu_init_failed",
    )?;

    let output = run_tofu_command(
        request,
        &tofu_resolution,
        &prepared_repo,
        &workspace_path,
        &["output", "-json", "-no-color"],
        "tofu_output_failed",
    )?;
    let outputs = parse_terraform_outputs(request, &workspace_path, &output.stdout)?;

    let mut diagnostics = repo_context_diagnostics(repo_context);
    diagnostics.push(DiagnosticMessage {
        level: DiagnosticLevel::Info,
        code: Some("tofu_resolved".to_string()),
        message: format!(
            "Resolved tofu via {} at '{}' ({})",
            tofu_source_label(tofu_resolution.source),
            tofu_resolution.path.display(),
            tofu_resolution.version
        ),
        workspace_path: Some(workspace_path.clone()),
        item_key: None,
        details: Some(BTreeMap::from([
            ("source".to_string(), json!(tofu_resolution.source)),
            (
                "path".to_string(),
                json!(tofu_resolution.path.display().to_string()),
            ),
            ("version".to_string(), json!(tofu_resolution.version)),
            ("attempts".to_string(), json!(tofu_report.attempts)),
        ])),
    });
    diagnostics.push(DiagnosticMessage {
        level: DiagnosticLevel::Info,
        code: Some("outputs_loaded".to_string()),
        message: format!(
            "Loaded {} output(s) for workspace '{}'.",
            outputs.len(),
            workspace_path
        ),
        workspace_path: Some(workspace_path.clone()),
        item_key: None,
        details: Some(BTreeMap::from([(
            "output_keys".to_string(),
            json!(outputs.keys().cloned().collect::<Vec<_>>()),
        )])),
    });

    let workspace_snapshots = graph_context
        .graph
        .workspaces
        .iter()
        .map(|workspace| WorkspaceSnapshot {
            workspace_path: workspace.path.clone(),
            lifecycle: None,
            materialization: None,
            freshness: None,
        })
        .collect::<Vec<_>>();

    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.as_str())
        .unwrap_or("unknown");

    Ok(build_response(
        request,
        OperationResultKind::Succeeded,
        format_outputs_summary(environment_name, &workspace_path, &outputs),
        workspace_snapshots,
        outputs,
        diagnostics,
    ))
}

fn execute_converge_operation(
    request: &EngineRequest,
    repo_context: &RepoContext,
) -> Result<EngineResponse, EngineError> {
    let graph_context = load_graph_context(repo_context, request)?;
    let tofu_report = inspect_tofu_resolution(&TofuResolutionRequest::default());
    let tofu_resolution = tofu_report.clone().into_result().map_err(|error| {
        request_error_with_details(
            request,
            "tofu_resolution_failed",
            "could not resolve tofu using the configured source policy",
            Some(BTreeMap::from([(
                "attempts".to_string(),
                json!(error.attempts),
            )])),
        )
    })?;

    let prepared_repo = prepare_execution_repo(&repo_context.repo_root, ".", request)?;
    let environment_kind = graph_context
        .graph
        .environment_kind
        .expect("converge operation should have an environment kind");

    for workspace_path in &graph_context.topological_order {
        let workspace_config = repo_context
            .config
            .workspaces
            .iter()
            .find(|workspace| workspace.path == *workspace_path)
            .expect("converge workspace should exist in config");

        let uses_local_backend = configure_workspace_execution(
            request,
            &prepared_repo,
            workspace_config,
            environment_kind,
        )?;

        run_tofu_command(
            request,
            &tofu_resolution,
            &prepared_repo,
            workspace_path,
            &["init", "-input=false", "-no-color"],
            "tofu_init_failed",
        )?;
        run_tofu_command(
            request,
            &tofu_resolution,
            &prepared_repo,
            workspace_path,
            &["apply", "-auto-approve", "-input=false", "-no-color"],
            "tofu_apply_failed",
        )?;

        if uses_local_backend {
            persist_local_backend_state(request, repo_context, &prepared_repo, workspace_path)?;
        }
    }

    let mut diagnostics = repo_context_diagnostics(repo_context);
    diagnostics.push(DiagnosticMessage {
        level: DiagnosticLevel::Info,
        code: Some("tofu_resolved".to_string()),
        message: format!(
            "Resolved tofu via {} at '{}' ({})",
            tofu_source_label(tofu_resolution.source),
            tofu_resolution.path.display(),
            tofu_resolution.version
        ),
        workspace_path: None,
        item_key: None,
        details: Some(BTreeMap::from([
            ("source".to_string(), json!(tofu_resolution.source)),
            (
                "path".to_string(),
                json!(tofu_resolution.path.display().to_string()),
            ),
            ("version".to_string(), json!(tofu_resolution.version)),
            ("attempts".to_string(), json!(tofu_report.attempts)),
        ])),
    });

    for (index, workspace_path) in graph_context.topological_order.iter().enumerate() {
        diagnostics.push(DiagnosticMessage {
            level: DiagnosticLevel::Info,
            code: Some("workspace_converged".to_string()),
            message: format!("Converged workspace '{}'.", workspace_path),
            workspace_path: Some(workspace_path.clone()),
            item_key: None,
            details: Some(BTreeMap::from([(
                "topological_index".to_string(),
                json!(index),
            )])),
        });
    }

    let workspace_snapshots = graph_context
        .topological_order
        .iter()
        .map(|workspace_path| WorkspaceSnapshot {
            workspace_path: workspace_path.clone(),
            lifecycle: None,
            materialization: None,
            freshness: None,
        })
        .collect::<Vec<_>>();

    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.as_str())
        .unwrap_or("unknown");

    Ok(build_response(
        request,
        OperationResultKind::Succeeded,
        format_converge_summary(environment_name, &graph_context.topological_order),
        workspace_snapshots,
        BTreeMap::new(),
        diagnostics,
    ))
}

fn execute_placeholder_operation(
    request: &EngineRequest,
    repo_context: Option<&RepoContext>,
) -> EngineResponse {
    let mut diagnostics = repo_context
        .map(repo_context_diagnostics)
        .unwrap_or_default();
    diagnostics.push(DiagnosticMessage {
        level: DiagnosticLevel::Warning,
        code: Some("not_implemented".to_string()),
        message: "This CLI alpha command is not fully implemented yet.".to_string(),
        workspace_path: None,
        item_key: None,
        details: None,
    });

    build_response(
        request,
        OperationResultKind::Partial,
        placeholder_summary(request),
        Vec::new(),
        BTreeMap::new(),
        diagnostics,
    )
}

fn execute_doctor_operation(request: &EngineRequest, working_dir: &Path) -> EngineResponse {
    let mut diagnostics = Vec::new();
    let mut summary_lines = Vec::new();
    let mut info_count = 0usize;
    let mut warning_count = 0usize;
    let mut error_count = 0usize;

    record_doctor_check(
        &mut diagnostics,
        &mut summary_lines,
        &mut info_count,
        &mut warning_count,
        &mut error_count,
        DiagnosticLevel::Info,
        "working_directory",
        format!("using working directory '{}'", working_dir.display()),
        None,
    );

    let tofu_report = inspect_tofu_resolution(&TofuResolutionRequest::default());
    match &tofu_report.selected {
        Some(resolution) => record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Info,
            "tofu_resolved",
            format!(
                "resolved tofu via {} at '{}' ({})",
                tofu_source_label(resolution.source),
                resolution.path.display(),
                resolution.version
            ),
            Some(BTreeMap::from([
                ("source".to_string(), json!(resolution.source)),
                (
                    "path".to_string(),
                    json!(resolution.path.display().to_string()),
                ),
                ("version".to_string(), json!(resolution.version)),
                ("attempts".to_string(), json!(tofu_report.attempts)),
            ])),
        ),
        None => record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Error,
            "tofu_resolution_failed",
            "could not resolve tofu using the configured source policy",
            Some(BTreeMap::from([(
                "attempts".to_string(),
                json!(tofu_report.attempts),
            )])),
        ),
    }

    let repo_context = match load_repo_context(working_dir, request) {
        Ok(repo_context) => repo_context,
        Err(error) => {
            record_doctor_check(
                &mut diagnostics,
                &mut summary_lines,
                &mut info_count,
                &mut warning_count,
                &mut error_count,
                DiagnosticLevel::Error,
                error.error.code,
                error.error.message,
                error.error.details,
            );

            return build_response(
                request,
                doctor_result_kind(error_count, warning_count),
                format_doctor_summary(info_count, warning_count, error_count, &summary_lines),
                Vec::new(),
                BTreeMap::new(),
                diagnostics,
            );
        }
    };

    record_doctor_check(
        &mut diagnostics,
        &mut summary_lines,
        &mut info_count,
        &mut warning_count,
        &mut error_count,
        DiagnosticLevel::Info,
        "config_loaded",
        format!(
            "loaded config from '{}'",
            repo_context.config_path.display()
        ),
        Some(BTreeMap::from([(
            "path".to_string(),
            json!(repo_context.config_path.display().to_string()),
        )])),
    );

    match &repo_context.current_namespace {
        Some(namespace) => record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Info,
            "repo_namespace_resolved",
            format!("inferred repo namespace '{}'", namespace),
            Some(BTreeMap::from([(
                "namespace".to_string(),
                json!(namespace),
            )])),
        ),
        None => record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Warning,
            "repo_namespace_unresolved",
            "could not infer repo namespace from git metadata; same-repo dependency filtering may be less strict",
            None,
        ),
    }

    let missing_workspace_directories = repo_context
        .config
        .workspaces
        .iter()
        .filter(|workspace| !repo_context.repo_root.join(&workspace.path).is_dir())
        .map(|workspace| workspace.path.clone())
        .collect::<Vec<_>>();

    if missing_workspace_directories.is_empty() {
        record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Info,
            "workspace_directories_present",
            format!(
                "found all {} configured workspace directories",
                repo_context.config.workspaces.len()
            ),
            Some(BTreeMap::from([(
                "workspace_count".to_string(),
                json!(repo_context.config.workspaces.len()),
            )])),
        );
    } else {
        record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Error,
            "workspace_directories_missing",
            format!(
                "{} configured workspace directories are missing",
                missing_workspace_directories.len()
            ),
            Some(BTreeMap::from([(
                "missing_workspaces".to_string(),
                json!(missing_workspace_directories),
            )])),
        );
    }

    match resolve_workspace_graph(
        &repo_context.repo_root,
        &repo_context.config,
        None,
        &WorkspaceGraphOptions {
            allowed_hosts: None,
            current_namespace: repo_context.current_namespace.clone(),
        },
    ) {
        Ok(graph) => record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Info,
            "static_graph_resolved",
            format!(
                "resolved static graph ({} workspaces, {} edges)",
                graph.workspaces.len(),
                graph_edge_count(&graph)
            ),
            Some(BTreeMap::from([
                ("workspace_count".to_string(), json!(graph.workspaces.len())),
                ("edge_count".to_string(), json!(graph_edge_count(&graph))),
            ])),
        ),
        Err(error) => record_graph_error(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            graph_error(request, error),
            Some("static repo graph".to_string()),
        ),
    }

    if repo_context.config.environments.is_empty() {
        record_doctor_check(
            &mut diagnostics,
            &mut summary_lines,
            &mut info_count,
            &mut warning_count,
            &mut error_count,
            DiagnosticLevel::Warning,
            "named_environments_missing",
            "config does not define any named environments",
            None,
        );
    } else {
        for environment in &repo_context.config.environments {
            match resolve_workspace_graph(
                &repo_context.repo_root,
                &repo_context.config,
                Some(&environment.name),
                &WorkspaceGraphOptions {
                    allowed_hosts: None,
                    current_namespace: repo_context.current_namespace.clone(),
                },
            ) {
                Ok(graph) => record_doctor_check(
                    &mut diagnostics,
                    &mut summary_lines,
                    &mut info_count,
                    &mut warning_count,
                    &mut error_count,
                    DiagnosticLevel::Info,
                    "environment_graph_resolved",
                    format!(
                        "resolved named environment '{}' ({} workspaces, {} edges)",
                        environment.name,
                        graph.workspaces.len(),
                        graph_edge_count(&graph)
                    ),
                    Some(BTreeMap::from([
                        ("environment".to_string(), json!(environment.name)),
                        ("workspace_count".to_string(), json!(graph.workspaces.len())),
                        ("edge_count".to_string(), json!(graph_edge_count(&graph))),
                    ])),
                ),
                Err(error) => record_graph_error(
                    &mut diagnostics,
                    &mut summary_lines,
                    &mut info_count,
                    &mut warning_count,
                    &mut error_count,
                    graph_error(
                        &EngineRequest {
                            operation: request.operation.clone(),
                            target: Some(EnvironmentTarget {
                                environment: environment.name.clone(),
                            }),
                            selection: WorkspaceSelection::default(),
                            wait_for: None,
                        },
                        error,
                    ),
                    Some(format!("environment '{}'", environment.name)),
                ),
            }
        }
    }

    build_response(
        request,
        doctor_result_kind(error_count, warning_count),
        format_doctor_summary(info_count, warning_count, error_count, &summary_lines),
        Vec::new(),
        BTreeMap::new(),
        diagnostics,
    )
}

fn load_repo_context(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<RepoContext, EngineError> {
    let config_path = find_yaffle_toml(working_dir).ok_or_else(|| {
        request_error(
            request,
            "config_not_found",
            format!(
                "Could not find `yaffle.toml` in '{}' or any parent directory.",
                working_dir.display()
            ),
        )
    })?;

    let raw = fs::read_to_string(&config_path).map_err(|error| {
        request_error(
            request,
            "config_read_failed",
            format!(
                "Failed to read '{}' as Yaffle config: {error}",
                config_path.display()
            ),
        )
    })?;

    let config = parse_yaffle_toml(&raw).map_err(|error| {
        request_error(
            request,
            "config_invalid",
            format!(
                "Invalid Yaffle config at '{}': {error}",
                config_path.display()
            ),
        )
    })?;

    let repo_root = config_path
        .parent()
        .expect("yaffle.toml should always have a parent directory")
        .to_path_buf();

    Ok(RepoContext {
        current_namespace: derive_current_namespace(&repo_root),
        repo_root,
        config_path,
        config,
    })
}

fn load_graph_context(
    repo_context: &RepoContext,
    request: &EngineRequest,
) -> Result<GraphContext, EngineError> {
    let graph = resolve_workspace_graph(
        &repo_context.repo_root,
        &repo_context.config,
        request
            .target
            .as_ref()
            .map(|target| target.environment.as_str()),
        &WorkspaceGraphOptions {
            allowed_hosts: None,
            current_namespace: repo_context.current_namespace.clone(),
        },
    )
    .map_err(|error| graph_error(request, error))?;

    let graph = apply_workspace_selection(&repo_context.config, &graph, &request.selection)
        .map_err(|error| graph_error(request, error))?;

    let topological_order = graph
        .topological_order()
        .map_err(|error| graph_error(request, error))?;

    Ok(GraphContext {
        graph,
        topological_order,
    })
}

fn validate_request(request: &EngineRequest) -> Result<(), EngineError> {
    let policy = operation_policy(&request.operation);

    match &request.target {
        Some(target) => validate_environment_name(&target.environment)
            .map_err(|error| request_error(request, "invalid_environment", error.to_string()))?,
        None if policy.requires_target => {
            return Err(request_error(
                request,
                "target_required",
                format!(
                    "Operation '{}' requires an environment target.",
                    operation_name(&request.operation)
                ),
            ));
        }
        None => {}
    }

    if request
        .selection
        .workspaces
        .iter()
        .any(|workspace| workspace.trim().is_empty())
    {
        return Err(request_error(
            request,
            "invalid_workspace_selection",
            "workspace selection entries must not be empty",
        ));
    }

    match policy.selection_mode {
        SelectionMode::Any => {}
        SelectionMode::None if !request.selection.is_empty() => {
            return Err(request_error(
                request,
                "workspace_selection_not_supported",
                format!(
                    "Operation '{}' does not support workspace selection.",
                    operation_name(&request.operation)
                ),
            ));
        }
        SelectionMode::ExactlyOne if request.selection.workspaces.len() != 1 => {
            return Err(request_error(
                request,
                "workspace_required",
                format!(
                    "Operation '{}' requires exactly one workspace selection.",
                    operation_name(&request.operation)
                ),
            ));
        }
        SelectionMode::None | SelectionMode::ExactlyOne => {}
    }

    if request.operation == EngineOperation::Wait
        && request
            .wait_for
            .as_ref()
            .map(|value| value.trim())
            .unwrap_or("")
            .is_empty()
    {
        return Err(request_error(
            request,
            "invalid_condition",
            "condition passed to --for must not be empty",
        ));
    }

    Ok(())
}

fn operation_policy(operation: &EngineOperation) -> OperationPolicy {
    match operation {
        EngineOperation::Converge => OperationPolicy {
            requires_target: true,
            requires_repo_context: true,
            selection_mode: SelectionMode::Any,
        },
        EngineOperation::Destroy => OperationPolicy {
            requires_target: true,
            requires_repo_context: true,
            selection_mode: SelectionMode::Any,
        },
        EngineOperation::Status => OperationPolicy {
            requires_target: true,
            requires_repo_context: true,
            selection_mode: SelectionMode::Any,
        },
        EngineOperation::Wait => OperationPolicy {
            requires_target: true,
            requires_repo_context: true,
            selection_mode: SelectionMode::None,
        },
        EngineOperation::Outputs => OperationPolicy {
            requires_target: true,
            requires_repo_context: true,
            selection_mode: SelectionMode::ExactlyOne,
        },
        EngineOperation::Graph => OperationPolicy {
            requires_target: false,
            requires_repo_context: true,
            selection_mode: SelectionMode::Any,
        },
        EngineOperation::Doctor => OperationPolicy {
            requires_target: false,
            requires_repo_context: false,
            selection_mode: SelectionMode::None,
        },
    }
}

fn operation_name(operation: &EngineOperation) -> &'static str {
    match operation {
        EngineOperation::Converge => "converge",
        EngineOperation::Destroy => "destroy",
        EngineOperation::Status => "status",
        EngineOperation::Wait => "wait",
        EngineOperation::Outputs => "outputs",
        EngineOperation::Graph => "graph",
        EngineOperation::Doctor => "doctor",
    }
}

fn placeholder_summary(request: &EngineRequest) -> String {
    match request.operation {
        EngineOperation::Converge => {
            "CLI alpha placeholder: converge execution is not implemented in Rust yet.".to_string()
        }
        EngineOperation::Destroy => {
            "CLI alpha placeholder: destroy execution is not implemented in Rust yet.".to_string()
        }
        EngineOperation::Status => {
            "CLI alpha placeholder: status execution is not implemented in Rust yet.".to_string()
        }
        EngineOperation::Wait => format!(
            "CLI alpha placeholder: waiting for condition '{}' is not implemented yet.",
            request.wait_for.as_deref().unwrap_or_default()
        ),
        EngineOperation::Outputs => {
            "CLI alpha placeholder: outputs execution is not implemented in Rust yet.".to_string()
        }
        EngineOperation::Graph => {
            "CLI alpha placeholder: graph execution is not implemented in Rust yet.".to_string()
        }
        EngineOperation::Doctor => {
            "CLI alpha placeholder: doctor execution is not implemented in Rust yet.".to_string()
        }
    }
}

fn repo_context_diagnostics(repo_context: &RepoContext) -> Vec<DiagnosticMessage> {
    let mut diagnostics = vec![DiagnosticMessage {
        level: DiagnosticLevel::Info,
        code: Some("config_loaded".to_string()),
        message: format!(
            "Loaded Yaffle config from '{}'.",
            repo_context.config_path.display()
        ),
        workspace_path: None,
        item_key: None,
        details: None,
    }];

    if repo_context.current_namespace.is_none() {
        diagnostics.push(DiagnosticMessage {
            level: DiagnosticLevel::Warning,
            code: Some("repo_namespace_unresolved".to_string()),
            message: "Could not infer the repo namespace from git metadata; same-repo dependency filtering may be less strict.".to_string(),
            workspace_path: None,
            item_key: None,
            details: None,
        });
    }

    diagnostics
}

fn prepare_execution_repo(
    source_repo_root: &Path,
    workspace_path: &str,
    request: &EngineRequest,
) -> Result<PreparedExecutionRepo, EngineError> {
    let temp_dir = tempfile::tempdir().map_err(|error| {
        request_error(
            request,
            "execution_workspace_prepare_failed",
            format!("Failed to create temporary execution directory: {error}"),
        )
    })?;
    let repo_root = temp_dir.path().to_path_buf();

    copy_repo_for_execution(source_repo_root, &repo_root).map_err(|error| {
        request_error(
            request,
            "execution_workspace_prepare_failed",
            format!(
                "Failed to prepare temporary execution repo from '{}': {error}",
                source_repo_root.display()
            ),
        )
    })?;

    let workspace_dir = repo_root.join(workspace_path);
    if !workspace_dir.is_dir() {
        return Err(request_error(
            request,
            "execution_workspace_missing",
            format!(
                "Selected workspace '{}' was not present in the prepared execution repo.",
                workspace_path
            ),
        ));
    }

    let tf_data_dir = repo_root
        .join(".yaffle-tf-data")
        .join(slugify_path(workspace_path));
    fs::create_dir_all(&tf_data_dir).map_err(|error| {
        request_error(
            request,
            "execution_workspace_prepare_failed",
            format!(
                "Failed to create TF_DATA_DIR for workspace '{}': {error}",
                workspace_path
            ),
        )
    })?;

    Ok(PreparedExecutionRepo {
        _temp_dir: temp_dir,
        repo_root,
        tf_data_dir,
    })
}

fn configure_workspace_execution(
    request: &EngineRequest,
    prepared_repo: &PreparedExecutionRepo,
    workspace: &yaffle_config::Workspace,
    environment_kind: EnvironmentKind,
) -> Result<bool, EngineError> {
    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.clone())
        .unwrap_or_default();
    let workspace_dir = prepared_repo.repo_root.join(&workspace.path);

    ensure_injected_variable_declarations(request, &workspace_dir)?;
    write_workspace_variables_file(
        request,
        &workspace_dir,
        workspace,
        &environment_name,
        environment_kind,
    )?;

    let has_explicit_backend = workspace_has_explicit_backend(request, &workspace_dir)?;
    if !has_explicit_backend {
        write_local_backend_override(request, prepared_repo, &workspace_dir, &workspace.path)?;
    }

    Ok(!has_explicit_backend)
}

fn run_tofu_command(
    request: &EngineRequest,
    tofu_resolution: &yaffle_tofu::TofuResolution,
    prepared_repo: &PreparedExecutionRepo,
    workspace_path: &str,
    args: &[&str],
    error_code: &'static str,
) -> Result<std::process::Output, EngineError> {
    let workspace_dir = prepared_repo.repo_root.join(workspace_path);
    let tf_data_dir = prepared_repo.tf_data_dir.join(slugify_path(workspace_path));
    fs::create_dir_all(&tf_data_dir).map_err(|error| {
        request_error(
            request,
            "execution_workspace_prepare_failed",
            format!(
                "Failed to create TF_DATA_DIR for workspace '{}': {error}",
                workspace_path
            ),
        )
    })?;

    let output = tofu_resolution
        .command()
        .current_dir(&workspace_dir)
        .env("TF_DATA_DIR", &tf_data_dir)
        .env("TF_IN_AUTOMATION", "1")
        .env("TOFU_IN_AUTOMATION", "1")
        .args(args)
        .output()
        .map_err(|error| {
            request_error_with_details(
                request,
                error_code,
                format!(
                    "Failed to execute tofu command '{}' for workspace '{}': {error}",
                    args.join(" "),
                    workspace_dir.display()
                ),
                Some(BTreeMap::from([
                    (
                        "workspace_dir".to_string(),
                        json!(workspace_dir.display().to_string()),
                    ),
                    (
                        "repo_root".to_string(),
                        json!(prepared_repo.repo_root.display().to_string()),
                    ),
                    ("args".to_string(), json!(args)),
                ])),
            )
        })?;

    if !output.status.success() {
        return Err(request_error_with_details(
            request,
            error_code,
            format!(
                "tofu {} failed for workspace '{}': {}",
                args.join(" "),
                workspace_dir.display(),
                utf8_trimmed(&output.stderr)
            ),
            Some(BTreeMap::from([
                ("workspace_path".to_string(), json!(workspace_path)),
                (
                    "workspace_dir".to_string(),
                    json!(workspace_dir.display().to_string()),
                ),
                (
                    "repo_root".to_string(),
                    json!(prepared_repo.repo_root.display().to_string()),
                ),
                ("args".to_string(), json!(args)),
                (
                    "exit_status".to_string(),
                    json!(output.status.code().unwrap_or_default()),
                ),
                ("stderr".to_string(), json!(utf8_trimmed(&output.stderr))),
            ])),
        ));
    }

    Ok(output)
}

fn parse_terraform_outputs(
    request: &EngineRequest,
    workspace_path: &str,
    stdout: &[u8],
) -> Result<BTreeMap<String, TerraformOutput>, EngineError> {
    let raw_outputs = serde_json::from_slice::<BTreeMap<String, RawTerraformOutput>>(stdout)
        .map_err(|error| {
            request_error_with_details(
                request,
                "outputs_parse_failed",
                format!(
                    "Failed to parse tofu output JSON for workspace '{}': {error}",
                    workspace_path
                ),
                Some(BTreeMap::from([(
                    "stdout".to_string(),
                    json!(String::from_utf8_lossy(stdout).to_string()),
                )])),
            )
        })?;

    Ok(raw_outputs
        .into_iter()
        .map(|(name, output)| {
            (
                name,
                TerraformOutput {
                    value: output.value,
                    type_name: output.type_name.and_then(terraform_output_type_name),
                    sensitive: output.sensitive,
                },
            )
        })
        .collect())
}

fn format_outputs_summary(
    environment_name: &str,
    workspace_path: &str,
    outputs: &BTreeMap<String, TerraformOutput>,
) -> String {
    let header = format!(
        "resolved {} output(s) for '{}' in environment '{}'",
        outputs.len(),
        workspace_path,
        environment_name
    );

    if outputs.is_empty() {
        return header;
    }

    let mut lines = vec![header, String::new()];
    for (name, output) in outputs {
        let rendered_value = if output.sensitive == Some(true) {
            "<sensitive>".to_string()
        } else {
            serde_json::to_string(&output.value).unwrap_or_else(|_| "<unserializable>".to_string())
        };

        lines.push(format!("{name} = {rendered_value}"));
    }

    lines.join("\n")
}

fn format_converge_summary(environment_name: &str, workspace_paths: &[String]) -> String {
    let header = format!(
        "converged {} workspace(s) for environment '{}'",
        workspace_paths.len(),
        environment_name
    );

    if workspace_paths.is_empty() {
        return header;
    }

    let mut lines = vec![header, String::new()];
    lines.extend(
        workspace_paths
            .iter()
            .map(|workspace_path| format!("- {workspace_path}")),
    );
    lines.join("\n")
}

fn write_workspace_variables_file(
    request: &EngineRequest,
    workspace_dir: &Path,
    workspace: &yaffle_config::Workspace,
    environment_name: &str,
    environment_kind: EnvironmentKind,
) -> Result<(), EngineError> {
    let mut variables = workspace_variable_values(&workspace.variables);
    variables.insert("environment".to_string(), json!(environment_name));
    variables.insert(
        "environment_kind".to_string(),
        json!(environment_kind_name(environment_kind)),
    );

    let serialized = serde_json::to_vec_pretty(&variables).map_err(|error| {
        request_error(
            request,
            "workspace_variables_serialize_failed",
            format!(
                "Failed to serialize variables for workspace '{}': {error}",
                workspace.path
            ),
        )
    })?;

    fs::write(workspace_dir.join("yaffle.auto.tfvars.json"), serialized).map_err(|error| {
        request_error(
            request,
            "workspace_variables_write_failed",
            format!(
                "Failed to write Yaffle variables file for workspace '{}': {error}",
                workspace.path
            ),
        )
    })
}

fn ensure_injected_variable_declarations(
    request: &EngineRequest,
    workspace_dir: &Path,
) -> Result<(), EngineError> {
    let body = load_workspace_hcl_body(request, workspace_dir)?;
    let declared_variables = body
        .blocks()
        .filter(|block| block.identifier() == "variable")
        .filter_map(|block| {
            block
                .labels()
                .first()
                .map(|label| label.as_str().to_string())
        })
        .collect::<BTreeSet<_>>();

    let missing_variables = [
        ("environment", "Environment name (injected by Yaffle)"),
        (
            "environment_kind",
            "Environment kind: 'named' or 'transient' (injected by Yaffle)",
        ),
    ]
    .into_iter()
    .filter(|(name, _)| !declared_variables.contains(*name))
    .collect::<Vec<_>>();

    if missing_variables.is_empty() {
        return Ok(());
    }

    let blocks = missing_variables
        .into_iter()
        .map(|(name, description)| {
            format!(
                "variable \"{name}\" {{\n  type        = string\n  description = \"{description}\"\n}}"
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let content = format!(
        "# Generated by Yaffle -- do not edit\n# These variables are injected by Yaffle if not declared in the workspace.\n\n{blocks}\n"
    );

    fs::write(workspace_dir.join("yaffle_injected_variables.tf"), content).map_err(|error| {
        request_error(
            request,
            "workspace_variables_write_failed",
            format!(
                "Failed to write injected variable declarations in '{}': {error}",
                workspace_dir.display()
            ),
        )
    })
}

fn workspace_has_explicit_backend(
    request: &EngineRequest,
    workspace_dir: &Path,
) -> Result<bool, EngineError> {
    let body = load_workspace_hcl_body(request, workspace_dir)?;

    Ok(body
        .blocks()
        .filter(|block| block.identifier() == "terraform")
        .any(|block| {
            block
                .body()
                .blocks()
                .any(|nested| nested.identifier() == "cloud" || nested.identifier() == "backend")
        }))
}

fn write_local_backend_override(
    request: &EngineRequest,
    prepared_repo: &PreparedExecutionRepo,
    workspace_dir: &Path,
    workspace_path: &str,
) -> Result<(), EngineError> {
    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.as_str())
        .unwrap_or("unknown");
    let state_path = prepared_repo
        .repo_root
        .join(".yaffle")
        .join("state")
        .join(environment_name)
        .join(workspace_path)
        .join("terraform.tfstate");

    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            request_error(
                request,
                "workspace_backend_write_failed",
                format!(
                    "Failed to create local state directory for workspace '{}': {error}",
                    workspace_path
                ),
            )
        })?;
    }

    let content = format!(
        "# Generated by Yaffle -- do not edit\nterraform {{\n  backend \"local\" {{\n    path = \"{}\"\n  }}\n}}\n",
        state_path.display()
    );

    fs::write(workspace_dir.join("backend_override.tf"), content).map_err(|error| {
        request_error(
            request,
            "workspace_backend_write_failed",
            format!(
                "Failed to write local backend override for workspace '{}': {error}",
                workspace_path
            ),
        )
    })
}

fn persist_local_backend_state(
    request: &EngineRequest,
    repo_context: &RepoContext,
    prepared_repo: &PreparedExecutionRepo,
    workspace_path: &str,
) -> Result<(), EngineError> {
    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.as_str())
        .unwrap_or("unknown");
    let source_state_dir = prepared_repo
        .repo_root
        .join(".yaffle")
        .join("state")
        .join(environment_name)
        .join(workspace_path);
    let destination_state_dir = repo_context
        .repo_root
        .join(".yaffle")
        .join("state")
        .join(environment_name)
        .join(workspace_path);

    if !source_state_dir.is_dir() {
        return Ok(());
    }

    fs::create_dir_all(&destination_state_dir).map_err(|error| {
        request_error(
            request,
            "workspace_state_persist_failed",
            format!(
                "Failed to create persisted state directory for workspace '{}': {error}",
                workspace_path
            ),
        )
    })?;

    for file_name in ["terraform.tfstate", "terraform.tfstate.backup"] {
        let source_path = source_state_dir.join(file_name);
        if !source_path.is_file() {
            continue;
        }

        fs::copy(&source_path, destination_state_dir.join(file_name)).map_err(|error| {
            request_error(
                request,
                "workspace_state_persist_failed",
                format!(
                    "Failed to persist local state file '{}' for workspace '{}': {error}",
                    file_name, workspace_path
                ),
            )
        })?;
    }

    Ok(())
}

fn terraform_output_type_name(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value),
        other => serde_json::to_string(&other).ok(),
    }
}

fn workspace_variable_values(
    variables: &BTreeMap<String, yaffle_config::VariableValue>,
) -> BTreeMap<String, Value> {
    variables
        .iter()
        .map(|(name, value)| {
            let value = match value {
                yaffle_config::VariableValue::String(value) => json!(value),
                yaffle_config::VariableValue::Integer(value) => json!(value),
                yaffle_config::VariableValue::Float(value) => json!(value),
                yaffle_config::VariableValue::Boolean(value) => json!(value),
            };

            (name.clone(), value)
        })
        .collect()
}

fn environment_kind_name(environment_kind: EnvironmentKind) -> &'static str {
    match environment_kind {
        EnvironmentKind::Named => "named",
        EnvironmentKind::Transient => "transient",
    }
}

fn load_workspace_hcl_body(
    request: &EngineRequest,
    workspace_dir: &Path,
) -> Result<Body, EngineError> {
    let mut body = Body::default();

    for entry in fs::read_dir(workspace_dir).map_err(|error| {
        request_error(
            request,
            "workspace_read_failed",
            format!(
                "Failed to read workspace directory '{}': {error}",
                workspace_dir.display()
            ),
        )
    })? {
        let entry = entry.map_err(|error| {
            request_error(
                request,
                "workspace_read_failed",
                format!(
                    "Failed to inspect workspace directory '{}': {error}",
                    workspace_dir.display()
                ),
            )
        })?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("tf") {
            continue;
        }

        let content = fs::read_to_string(&path).map_err(|error| {
            request_error(
                request,
                "workspace_read_failed",
                format!(
                    "Failed to read workspace file '{}': {error}",
                    path.display()
                ),
            )
        })?;
        let parsed = hcl::from_str::<Body>(&content).map_err(|error| {
            request_error(
                request,
                "workspace_parse_failed",
                format!(
                    "Failed to parse workspace file '{}': {error}",
                    path.display()
                ),
            )
        })?;
        body.extend(parsed);
    }

    Ok(body)
}

fn copy_repo_for_execution(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if should_skip_execution_copy(&name) {
            continue;
        }

        let target = destination.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_repo_for_execution(&path, &target)?;
        } else if file_type.is_file() {
            fs::copy(&path, &target)?;
        }
    }

    Ok(())
}

fn should_skip_execution_copy(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".jj" | ".dev" | ".direnv" | "target" | "node_modules" | ".terraform"
    )
}

fn slugify_path(path: &str) -> String {
    path.chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' => character,
            _ => '-',
        })
        .collect()
}

fn utf8_trimmed(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn build_response(
    request: &EngineRequest,
    result_kind: OperationResultKind,
    summary: impl Into<String>,
    workspaces: Vec<WorkspaceSnapshot>,
    outputs: BTreeMap<String, TerraformOutput>,
    diagnostics: Vec<DiagnosticMessage>,
) -> EngineResponse {
    EngineResponse {
        contract_version: CONTRACT_VERSION,
        operation: request.operation.clone(),
        target: request.target.clone(),
        selection: request.selection.clone(),
        result: OperationResult {
            kind: result_kind,
            summary: summary.into(),
        },
        environment: None,
        workspaces,
        outputs,
        diagnostics,
        metrics: None,
    }
}

fn doctor_result_kind(error_count: usize, warning_count: usize) -> OperationResultKind {
    if error_count > 0 {
        OperationResultKind::Failed
    } else if warning_count > 0 {
        OperationResultKind::Degraded
    } else {
        OperationResultKind::Succeeded
    }
}

fn format_doctor_summary(
    info_count: usize,
    warning_count: usize,
    error_count: usize,
    summary_lines: &[String],
) -> String {
    let header = if error_count > 0 {
        format!(
            "doctor found {} error(s), {} warning(s), {} passing check(s)",
            error_count, warning_count, info_count
        )
    } else if warning_count > 0 {
        format!(
            "doctor found {} warning(s), {} passing check(s)",
            warning_count, info_count
        )
    } else {
        format!("doctor passed {} check(s)", info_count)
    };

    let mut lines = vec![header, String::new()];
    lines.extend(summary_lines.iter().cloned());
    lines.join("\n")
}

#[allow(clippy::too_many_arguments)]
fn record_doctor_check(
    diagnostics: &mut Vec<DiagnosticMessage>,
    summary_lines: &mut Vec<String>,
    info_count: &mut usize,
    warning_count: &mut usize,
    error_count: &mut usize,
    level: DiagnosticLevel,
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<BTreeMap<String, Value>>,
) {
    let code = code.into();
    let message = message.into();

    match level {
        DiagnosticLevel::Info => {
            *info_count += 1;
            summary_lines.push(format!("[ok] {message}"));
        }
        DiagnosticLevel::Warning => {
            *warning_count += 1;
            summary_lines.push(format!("[warn] {message}"));
        }
        DiagnosticLevel::Error => {
            *error_count += 1;
            summary_lines.push(format!("[fail] {message}"));
        }
    }

    diagnostics.push(DiagnosticMessage {
        level,
        code: Some(code),
        message,
        workspace_path: None,
        item_key: None,
        details,
    });
}

#[allow(clippy::too_many_arguments)]
fn record_graph_error(
    diagnostics: &mut Vec<DiagnosticMessage>,
    summary_lines: &mut Vec<String>,
    info_count: &mut usize,
    warning_count: &mut usize,
    error_count: &mut usize,
    error: EngineError,
    scope: Option<String>,
) {
    let summary_message = match &scope {
        Some(scope) => format!("{}: {}", scope, error.error.message),
        None => error.error.message.clone(),
    };
    let details = with_optional_scope_details(scope, error.error.details);

    record_doctor_check(
        diagnostics,
        summary_lines,
        info_count,
        warning_count,
        error_count,
        DiagnosticLevel::Error,
        error.error.code,
        summary_message,
        details,
    );
}

fn with_optional_scope_details(
    scope: Option<String>,
    details: Option<BTreeMap<String, Value>>,
) -> Option<BTreeMap<String, Value>> {
    match (scope, details) {
        (None, None) => None,
        (Some(scope), None) => Some(BTreeMap::from([("scope".to_string(), json!(scope))])),
        (None, Some(details)) => Some(details),
        (Some(scope), Some(mut details)) => {
            details.insert("scope".to_string(), json!(scope));
            Some(details)
        }
    }
}

fn graph_edge_count(graph: &ResolvedWorkspaceGraph) -> usize {
    graph
        .workspaces
        .iter()
        .map(|workspace| workspace.dependencies.len())
        .sum()
}

fn tofu_source_label(source: TofuSourceKind) -> &'static str {
    match source {
        TofuSourceKind::Override => "override",
        TofuSourceKind::Bundled => "bundled",
        TofuSourceKind::Managed => "managed",
        TofuSourceKind::System => "system",
    }
}

fn request_error(
    request: &EngineRequest,
    code: impl Into<String>,
    message: impl Into<String>,
) -> EngineError {
    request_error_with_details(request, code, message, None)
}

fn request_error_with_details(
    request: &EngineRequest,
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<BTreeMap<String, Value>>,
) -> EngineError {
    EngineError {
        contract_version: CONTRACT_VERSION,
        operation: Some(request.operation.clone()),
        target: request.target.clone(),
        selection: Some(request.selection.clone()),
        error: yaffle_contracts::ErrorPayload {
            code: code.into(),
            message: message.into(),
            details,
        },
    }
}

fn find_yaffle_toml(start: &Path) -> Option<PathBuf> {
    for directory in start.ancestors() {
        let candidate = directory.join("yaffle.toml");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn derive_current_namespace(repo_root: &Path) -> Option<String> {
    let config_path = resolve_git_config_path(repo_root)?;
    let config = fs::read_to_string(config_path).ok()?;
    let remote_url = extract_preferred_remote_url(&config)?;
    namespace_from_remote_url(&remote_url)
}

fn resolve_git_config_path(repo_root: &Path) -> Option<PathBuf> {
    let git_path = repo_root.join(".git");

    if git_path.is_dir() {
        return Some(git_path.join("config"));
    }

    if git_path.is_file() {
        let pointer = fs::read_to_string(git_path).ok()?;
        let git_dir = pointer.strip_prefix("gitdir:")?.trim();
        let git_dir = PathBuf::from(git_dir);
        let resolved = if git_dir.is_absolute() {
            git_dir
        } else {
            repo_root.join(git_dir)
        };

        return Some(resolved.join("config"));
    }

    None
}

fn extract_preferred_remote_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    let mut fallback = None;

    for line in config.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_origin = trimmed == "[remote \"origin\"]";
            continue;
        }

        let Some(url) = trimmed.strip_prefix("url =") else {
            continue;
        };
        let url = url.trim().to_string();

        if in_origin {
            return Some(url);
        }

        if fallback.is_none() {
            fallback = Some(url);
        }
    }

    fallback
}

fn namespace_from_remote_url(remote_url: &str) -> Option<String> {
    for prefix in [
        "git@github.com:",
        "ssh://git@github.com/",
        "https://github.com/",
        "http://github.com/",
    ] {
        if let Some(path) = remote_url.strip_prefix(prefix) {
            return namespace_from_owner_repo_path(path);
        }
    }

    None
}

fn namespace_from_owner_repo_path(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);

    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(format!("{owner}--{repo}"))
}

fn graph_error(request: &EngineRequest, error: GraphError) -> EngineError {
    match error {
        GraphError::UnknownWorkspace { workspace } => request_error_with_details(
            request,
            "invalid_workspace_selection",
            format!(
                "Workspace selection references unknown workspace '{}'.",
                workspace
            ),
            Some(BTreeMap::from([(
                "workspace".to_string(),
                json!(workspace),
            )])),
        ),
        GraphError::WorkspaceNotInEnvironment {
            workspace,
            environment,
        } => request_error_with_details(
            request,
            "workspace_not_in_environment",
            format!(
                "Workspace '{}' is not active in environment '{}'.",
                workspace, environment
            ),
            Some(BTreeMap::from([
                ("workspace".to_string(), json!(workspace)),
                ("environment".to_string(), json!(environment)),
            ])),
        ),
        GraphError::DependencyCycle { cycle_path } => request_error_with_details(
            request,
            "dependency_cycle",
            format!(
                "Workspace dependency cycle detected: {}",
                cycle_path.join(" -> ")
            ),
            Some(BTreeMap::from([(
                "cycle_path".to_string(),
                json!(cycle_path),
            )])),
        ),
    }
}

fn build_dependents(graph: &ResolvedWorkspaceGraph) -> BTreeMap<String, Vec<String>> {
    let mut dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for workspace in &graph.workspaces {
        for dependency in &workspace.dependencies {
            dependents
                .entry(dependency.clone())
                .or_default()
                .push(workspace.path.clone());
        }
    }

    for dependents_for_workspace in dependents.values_mut() {
        dependents_for_workspace.sort();
    }

    dependents
}

fn format_graph_summary(graph: &ResolvedWorkspaceGraph, order: &[String]) -> String {
    let edge_count = graph
        .workspaces
        .iter()
        .map(|workspace| workspace.dependencies.len())
        .sum::<usize>();

    let header = match (&graph.environment, graph.environment_kind) {
        (Some(environment), Some(EnvironmentKind::Named)) => {
            format!("environment-resolved graph for '{}'", environment,)
        }
        (Some(environment), Some(EnvironmentKind::Transient)) => {
            format!("environment-resolved graph for '{}'", environment,)
        }
        _ => "static repo graph".to_string(),
    };

    let dag = render_graph_dag(graph, order);

    [
        header,
        format!("{} workspaces, {} edges", order.len(), edge_count),
        "left to right = dependency depth".to_string(),
        String::new(),
        dag,
    ]
    .join("\n")
}

fn render_graph_dag(graph: &ResolvedWorkspaceGraph, order: &[String]) -> String {
    let layout = build_graph_layout(graph, order);
    let mut canvas = GraphCanvas::new(layout.height(), layout.width());

    let mut edge_id = 0;

    for workspace in &graph.workspaces {
        let target_stage = layout.stage_for(&workspace.path);
        let target_row = layout.row_for(&workspace.path);
        let target_x = layout.x_for_stage(target_stage);

        for dependency in &workspace.dependencies {
            edge_id += 1;
            let source_stage = layout.stage_for(dependency);
            let source_row = layout.row_for(dependency);
            let source_x = layout.x_for_stage(source_stage);

            let source_end = source_x + layout.label_for(dependency).len();
            let bend_x = target_x.saturating_sub(3);
            let arrow_x = target_x.saturating_sub(1);

            if source_row == target_row {
                if source_end <= target_x.saturating_sub(2) {
                    canvas.add_horizontal(source_row, source_end, target_x - 2, edge_id);
                }
            } else {
                if source_end <= bend_x {
                    canvas.add_horizontal(source_row, source_end, bend_x, edge_id);
                }
                canvas.add_vertical(bend_x, source_row, target_row, edge_id);
                canvas.add_horizontal(target_row, bend_x, target_x - 2, edge_id);
            }

            canvas.set_arrow_right(target_row, arrow_x);
        }
    }

    let cells = canvas.into_cells();
    let mut grid = cells
        .iter()
        .map(|row| {
            row.iter()
                .cloned()
                .map(render_graph_cell)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    for (row_index, row) in cells.iter().enumerate() {
        for (column_index, cell) in row.iter().enumerate() {
            if !cell.is_crossing() {
                continue;
            }

            if row_index == 0 || column_index == 0 || column_index + 1 >= grid[row_index].len() {
                continue;
            }

            grid[row_index - 1][column_index - 1] = '╭';
            grid[row_index - 1][column_index] = '─';
            grid[row_index - 1][column_index + 1] = '╮';

            grid[row_index][column_index - 1] = '╯';
            grid[row_index][column_index] = '│';
            grid[row_index][column_index + 1] = '╰';
        }
    }

    for workspace_path in &layout.ordered_nodes {
        let token = layout.label_for(workspace_path);
        let row = layout.row_for(workspace_path);
        let x = layout.x_for_stage(layout.stage_for(workspace_path));
        for (offset, character) in token.chars().enumerate() {
            grid[row][x + offset] = character;
        }
    }

    let title = match (&graph.environment, graph.environment_kind) {
        (Some(environment), Some(EnvironmentKind::Named)) => format!("{} [named]", environment),
        (Some(environment), Some(EnvironmentKind::Transient)) => {
            format!("{} [transient]", environment)
        }
        _ => "repo".to_string(),
    };

    let mut lines = vec![title];
    lines.extend(
        grid.into_iter()
            .map(|row| row.into_iter().collect::<String>())
            .map(|row| row.trim_end().to_string())
            .filter(|row| !row.is_empty()),
    );

    lines.join("\n")
}

#[derive(Debug)]
struct GraphLayout {
    node_labels: BTreeMap<String, String>,
    stage_offsets: Vec<usize>,
    stage_widths: Vec<usize>,
    node_stages: BTreeMap<String, usize>,
    node_rows: BTreeMap<String, usize>,
    ordered_nodes: Vec<String>,
}

impl GraphLayout {
    fn stage_for(&self, workspace_path: &str) -> usize {
        self.node_stages
            .get(workspace_path)
            .copied()
            .expect("workspace should have a stage")
    }

    fn row_for(&self, workspace_path: &str) -> usize {
        self.node_rows
            .get(workspace_path)
            .copied()
            .expect("workspace should have a row")
    }

    fn x_for_stage(&self, stage: usize) -> usize {
        self.stage_offsets[stage]
    }

    fn label_for(&self, workspace_path: &str) -> &str {
        self.node_labels
            .get(workspace_path)
            .map(|label| label.as_str())
            .expect("workspace should have a label")
    }

    fn width(&self) -> usize {
        let max_stage = self.node_stages.values().copied().max().unwrap_or(0);
        self.x_for_stage(max_stage) + self.stage_widths[max_stage]
    }

    fn height(&self) -> usize {
        self.ordered_nodes
            .len()
            .saturating_mul(2)
            .saturating_sub(1)
            .max(1)
    }
}

fn build_graph_layout(graph: &ResolvedWorkspaceGraph, order: &[String]) -> GraphLayout {
    let topo_rank = order
        .iter()
        .enumerate()
        .map(|(index, workspace_path)| (workspace_path.clone(), index))
        .collect::<BTreeMap<_, _>>();

    let mut node_stages = BTreeMap::new();
    let node_labels = order
        .iter()
        .map(|workspace_path| (workspace_path.clone(), format!("[{workspace_path}]")))
        .collect::<BTreeMap<_, _>>();

    for workspace_path in order {
        let workspace = graph
            .workspace(workspace_path)
            .expect("ordered workspace should exist in resolved graph");
        let stage = workspace
            .dependencies
            .iter()
            .map(|dependency| node_stages.get(dependency).copied().unwrap_or(0) + 1)
            .max()
            .unwrap_or(0);

        node_stages.insert(workspace.path.clone(), stage);
    }

    let max_stage = node_stages.values().copied().max().unwrap_or(0);
    let mut stage_widths = vec![0; max_stage + 1];
    for workspace_path in order {
        let stage = node_stages.get(workspace_path).copied().unwrap_or(0);
        stage_widths[stage] = stage_widths[stage].max(node_labels[workspace_path].len());
    }

    let mut stage_offsets = Vec::with_capacity(stage_widths.len());
    let mut current_offset = 0;
    for stage_width in &stage_widths {
        stage_offsets.push(current_offset);
        current_offset += *stage_width + 6;
    }

    let mut ordered_nodes = order.to_vec();
    ordered_nodes.sort_by_key(|workspace_path| {
        (
            node_stages.get(workspace_path).copied().unwrap_or(0),
            topo_rank.get(workspace_path).copied().unwrap_or(usize::MAX),
        )
    });

    let node_rows = ordered_nodes
        .iter()
        .enumerate()
        .map(|(index, workspace_path)| (workspace_path.clone(), index * 2))
        .collect();

    GraphLayout {
        node_labels,
        stage_offsets,
        stage_widths,
        node_stages,
        node_rows,
        ordered_nodes,
    }
}

#[derive(Clone, Debug, Default)]
struct GraphCell {
    up: bool,
    down: bool,
    left: bool,
    right: bool,
    arrow_right: bool,
    horizontal_edges: BTreeSet<usize>,
    vertical_edges: BTreeSet<usize>,
}

#[derive(Debug)]
struct GraphCanvas {
    cells: Vec<Vec<GraphCell>>,
}

impl GraphCanvas {
    fn new(height: usize, width: usize) -> Self {
        Self {
            cells: vec![vec![GraphCell::default(); width]; height],
        }
    }

    fn add_horizontal(&mut self, row: usize, start_x: usize, end_x: usize, edge_id: usize) {
        if start_x >= self.cells[row].len() || end_x >= self.cells[row].len() || start_x > end_x {
            return;
        }

        for x in start_x..=end_x {
            self.cells[row][x].horizontal_edges.insert(edge_id);
            if x > start_x {
                self.cells[row][x].left = true;
            }
            if x < end_x {
                self.cells[row][x].right = true;
            }
        }
    }

    fn add_vertical(&mut self, column: usize, start_row: usize, end_row: usize, edge_id: usize) {
        if start_row == end_row || column >= self.cells[0].len() {
            return;
        }

        let (min_row, max_row) = if start_row < end_row {
            (start_row, end_row)
        } else {
            (end_row, start_row)
        };

        for row in min_row..=max_row {
            self.cells[row][column].vertical_edges.insert(edge_id);
            if row > min_row {
                self.cells[row][column].up = true;
            }
            if row < max_row {
                self.cells[row][column].down = true;
            }
        }
    }

    fn set_arrow_right(&mut self, row: usize, column: usize) {
        if row >= self.cells.len() || column >= self.cells[row].len() {
            return;
        }

        self.cells[row][column].arrow_right = true;
    }

    fn into_cells(self) -> Vec<Vec<GraphCell>> {
        self.cells
    }
}

impl GraphCell {
    fn is_crossing(&self) -> bool {
        !self.horizontal_edges.is_empty()
            && !self.vertical_edges.is_empty()
            && self.horizontal_edges.is_disjoint(&self.vertical_edges)
    }
}

fn render_graph_cell(cell: GraphCell) -> char {
    if cell.arrow_right {
        return '▶';
    }

    match (cell.up, cell.down, cell.left, cell.right) {
        (false, false, false, false) => ' ',
        (false, false, true, true) => '─',
        (true, true, false, false) => '│',
        (false, true, false, true) => '┌',
        (true, false, false, true) => '└',
        (false, true, true, false) => '┐',
        (true, false, true, false) => '┘',
        (true, true, false, true) => '├',
        (true, true, true, false) => '┤',
        (false, true, true, true) => '┬',
        (true, false, true, true) => '┴',
        (true, true, true, true) => '┼',
        (false, false, false, true) | (false, false, true, false) => '─',
        (false, true, false, false) | (true, false, false, false) => '│',
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{LazyLock, Mutex};

    use tempfile::TempDir;
    use yaffle_contracts::{EngineOperation, OperationResultKind};
    use yaffle_tofu::TOFU_OVERRIDE_ENV_VAR;

    use super::*;

    static TOFU_OVERRIDE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn executes_graph_from_nested_workspace_directory() {
        let repo = TempDir::new().expect("temp dir should exist");

        fs::create_dir_all(repo.path().join(".git")).expect("git dir should exist");
        fs::write(
            repo.path().join(".git/config"),
            "[remote \"origin\"]\n  url = https://github.com/acme/platform.git\n",
        )
        .expect("git config should exist");

        fs::write(
            repo.path().join("yaffle.toml"),
            r#"version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/shared"
environments = ["main"]

[[workspaces]]
path = "apps/web/infra"
environments = ["main"]
"#,
        )
        .expect("config should be written");

        write_workspace_file(
            repo.path(),
            "infra/shared/main.tf",
            "resource \"null_resource\" \"x\" {}\n",
        );
        write_workspace_file(
            repo.path(),
            "apps/web/infra/main.tf",
            r#"variable "module_registry_host" {
  default = "yaffle.dev"
}

module "shared" {
  source = "${var.module_registry_host}/acme--platform/infra--shared/yaffle"
}
"#,
        );

        let response = execute(
            &EngineRequest {
                operation: EngineOperation::Graph,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            &repo.path().join("apps/web/infra"),
        )
        .expect("graph should execute");

        assert_eq!(response.result.kind, OperationResultKind::Succeeded);
        assert_eq!(
            response
                .workspaces
                .iter()
                .map(|workspace| workspace.workspace_path.as_str())
                .collect::<Vec<_>>(),
            vec!["infra/shared", "apps/web/infra"],
        );
        assert!(response
            .result
            .summary
            .contains("environment-resolved graph for 'main'"));
        assert!(response
            .result
            .summary
            .contains("left to right = dependency depth"));
        assert!(response.result.summary.contains("main [named]"));
        assert!(response.result.summary.contains("[infra/shared]"));
        assert!(response.result.summary.contains("[apps/web/infra]"));
        assert!(!response.result.summary.contains("legend"));
    }

    #[test]
    fn renders_inline_workspace_names_in_dag() {
        let graph = ResolvedWorkspaceGraph {
            environment: Some("main".to_string()),
            environment_kind: Some(EnvironmentKind::Named),
            workspaces: vec![
                yaffle_graph::WorkspaceNode {
                    path: "infra/shared".to_string(),
                    dependencies: Vec::new(),
                },
                yaffle_graph::WorkspaceNode {
                    path: "infra/production".to_string(),
                    dependencies: Vec::new(),
                },
                yaffle_graph::WorkspaceNode {
                    path: "apps/control-plane/infra".to_string(),
                    dependencies: vec!["infra/shared".to_string(), "infra/production".to_string()],
                },
            ],
        };

        let summary = format_graph_summary(
            &graph,
            &[
                "infra/shared".to_string(),
                "infra/production".to_string(),
                "apps/control-plane/infra".to_string(),
            ],
        );

        assert!(summary.contains("main [named]"));
        assert!(summary.contains("left to right = dependency depth"));
        assert!(summary.contains("[infra/shared]"));
        assert!(summary.contains("[infra/production]"));
        assert!(summary.contains("[apps/control-plane/infra]"));
        assert!(summary.contains("╭─╮") || summary.contains("╯│╰") || summary.contains("▶"));
        assert!(!summary.contains("legend"));
    }

    #[test]
    fn dispatches_placeholder_operations_through_shared_repo_context() {
        let repo = TempDir::new().expect("temp dir should exist");

        fs::write(
            repo.path().join("yaffle.toml"),
            r#"version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/shared"
environments = ["main"]
"#,
        )
        .expect("config should be written");

        let response = execute(
            &EngineRequest {
                operation: EngineOperation::Status,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            repo.path(),
        )
        .expect("status placeholder should execute");

        assert_eq!(response.result.kind, OperationResultKind::Partial);
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_deref() == Some("config_loaded")));
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_deref() == Some("not_implemented")));
    }

    #[test]
    fn validates_outputs_workspace_selection_in_engine_dispatch() {
        let error = execute(
            &EngineRequest {
                operation: EngineOperation::Outputs,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            Path::new("/tmp"),
        )
        .expect_err("outputs should require exactly one workspace");

        assert_eq!(error.error.code, "workspace_required");
    }

    #[test]
    fn validates_wait_condition_in_engine_dispatch() {
        let error = execute(
            &EngineRequest {
                operation: EngineOperation::Wait,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
                wait_for: Some("   ".to_string()),
            },
            Path::new("/tmp"),
        )
        .expect_err("wait should require a non-empty condition");

        assert_eq!(error.error.code, "invalid_condition");
    }

    #[test]
    fn doctor_reports_repo_health_for_valid_config() {
        let repo = TempDir::new().expect("temp dir should exist");
        let _guard = TOFU_OVERRIDE_LOCK.lock().expect("lock should succeed");
        let tofu_path = write_fake_tofu(repo.path().join("fake-tofu"), "1.11.5");
        env::set_var(TOFU_OVERRIDE_ENV_VAR, &tofu_path);

        fs::create_dir_all(repo.path().join(".git")).expect("git dir should exist");
        fs::write(
            repo.path().join(".git/config"),
            "[remote \"origin\"]\n  url = https://github.com/acme/platform.git\n",
        )
        .expect("git config should exist");

        fs::write(
            repo.path().join("yaffle.toml"),
            r#"version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/shared"
environments = ["main"]

[[workspaces]]
path = "apps/web/infra"
environments = ["main"]
"#,
        )
        .expect("config should be written");

        write_workspace_file(
            repo.path(),
            "infra/shared/main.tf",
            "resource \"null_resource\" \"x\" {}\n",
        );
        write_workspace_file(
            repo.path(),
            "apps/web/infra/main.tf",
            r#"module "shared" {
  source = "yaffle.dev/acme--platform/infra--shared/yaffle"
}
"#,
        );

        let response = execute(
            &EngineRequest {
                operation: EngineOperation::Doctor,
                target: None,
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            repo.path(),
        )
        .expect("doctor should execute");

        env::remove_var(TOFU_OVERRIDE_ENV_VAR);

        assert_ne!(response.result.kind, OperationResultKind::Failed);
        assert!(response.result.summary.contains("doctor"));
        assert!(response.result.summary.contains("[ok] resolved tofu via"));
        assert!(response.result.summary.contains("[ok] loaded config"));
        assert!(response
            .result
            .summary
            .contains("[ok] resolved static graph"));
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_deref() == Some("environment_graph_resolved")));
    }

    #[test]
    fn doctor_reports_missing_workspace_directories() {
        let repo = TempDir::new().expect("temp dir should exist");
        let _guard = TOFU_OVERRIDE_LOCK.lock().expect("lock should succeed");
        let tofu_path = write_fake_tofu(repo.path().join("fake-tofu"), "1.11.5");
        env::set_var(TOFU_OVERRIDE_ENV_VAR, &tofu_path);

        fs::write(
            repo.path().join("yaffle.toml"),
            r#"version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/missing"
environments = ["main"]
"#,
        )
        .expect("config should be written");

        let response = execute(
            &EngineRequest {
                operation: EngineOperation::Doctor,
                target: None,
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            repo.path(),
        )
        .expect("doctor should execute");

        env::remove_var(TOFU_OVERRIDE_ENV_VAR);

        assert_eq!(response.result.kind, OperationResultKind::Failed);
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_deref() == Some("workspace_directories_missing")));
    }

    #[test]
    fn doctor_reports_missing_config_without_engine_error() {
        let repo = TempDir::new().expect("temp dir should exist");
        let _guard = TOFU_OVERRIDE_LOCK.lock().expect("lock should succeed");
        let tofu_path = write_fake_tofu(repo.path().join("fake-tofu"), "1.11.5");
        env::set_var(TOFU_OVERRIDE_ENV_VAR, &tofu_path);

        let response = execute(
            &EngineRequest {
                operation: EngineOperation::Doctor,
                target: None,
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            repo.path(),
        )
        .expect("doctor should convert missing config into a report");

        env::remove_var(TOFU_OVERRIDE_ENV_VAR);

        assert_eq!(response.result.kind, OperationResultKind::Failed);
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_deref() == Some("config_not_found")));
        assert!(response.result.summary.contains("[fail]"));
    }

    #[test]
    fn injects_missing_environment_variable_declarations() {
        let repo = TempDir::new().expect("temp dir should exist");
        let workspace_dir = repo.path().join("infra/app");
        fs::create_dir_all(&workspace_dir).expect("workspace dir should exist");
        fs::write(
            workspace_dir.join("main.tf"),
            "locals {\n  descriptor = \"${var.environment}:${var.environment_kind}\"\n}\n",
        )
        .expect("fixture file should be written");

        ensure_injected_variable_declarations(
            &EngineRequest {
                operation: EngineOperation::Converge,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
                wait_for: None,
            },
            &workspace_dir,
        )
        .expect("missing variable declarations should be injected");

        let content = fs::read_to_string(workspace_dir.join("yaffle_injected_variables.tf"))
            .expect("injected variables file should exist");
        assert!(content.contains("variable \"environment\""));
        assert!(content.contains("variable \"environment_kind\""));
    }

    #[test]
    fn derives_repo_namespace_from_remote_url() {
        assert_eq!(
            namespace_from_remote_url("https://github.com/yaffle-dot-dev/yaffle.git"),
            Some("yaffle-dot-dev--yaffle".to_string()),
        );
        assert_eq!(
            namespace_from_remote_url("git@github.com:acme/platform.git"),
            Some("acme--platform".to_string()),
        );
    }

    fn write_workspace_file(repo_root: &Path, relative_path: &str, content: &str) {
        let path = repo_root.join(relative_path);
        fs::create_dir_all(path.parent().expect("parent directory should exist"))
            .expect("directories should be created");
        fs::write(path, content).expect("workspace file should be written");
    }

    fn write_fake_tofu(path: PathBuf, version: &str) -> PathBuf {
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"version\" ] && [ \"$2\" = \"-json\" ]; then\n  printf '{{\"terraform_version\":\"{version}\"}}\\n'\n  exit 0\nfi\nif [ \"$1\" = \"version\" ]; then\n  printf 'OpenTofu v{version}\\n'\n  exit 0\nfi\nexit 1\n"
        );

        fs::write(&path, script).expect("script should be written");
        let mut permissions = fs::metadata(&path)
            .expect("metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("permissions should be updated");
        path
    }
}
