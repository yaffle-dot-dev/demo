use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use yaffle_contracts::{
    DiagnosticLevel, DiagnosticMessage, EngineOperation, EngineResponse, OperationResult,
    OperationResultKind, WorkspaceSnapshot,
};
use yaffle_graph::{
    apply_workspace_selection, resolve_workspace_graph, EnvironmentKind, GraphError,
    ResolvedWorkspaceGraph, WorkspaceGraphOptions,
};

use yaffle_config::parse_yaffle_toml;
pub use yaffle_contracts::{EngineError, EnvironmentTarget, WorkspaceSelection, CONTRACT_VERSION};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRequest {
    pub operation: EngineOperation,
    pub target: Option<EnvironmentTarget>,
    pub selection: WorkspaceSelection,
}

pub fn execute_graph(
    request: &EngineRequest,
    working_dir: &Path,
) -> Result<EngineResponse, EngineError> {
    let (repo_root, config_path, config) = load_repo_config(working_dir, request)?;
    let current_namespace = derive_current_namespace(&repo_root);

    let mut diagnostics = Vec::new();
    diagnostics.push(DiagnosticMessage {
        level: DiagnosticLevel::Info,
        code: Some("config_loaded".to_string()),
        message: format!("Loaded Yaffle config from '{}'.", config_path.display()),
        workspace_path: None,
        item_key: None,
        details: None,
    });

    if current_namespace.is_none() {
        diagnostics.push(DiagnosticMessage {
            level: DiagnosticLevel::Warning,
            code: Some("repo_namespace_unresolved".to_string()),
            message: "Could not infer the repo namespace from git metadata; same-repo dependency filtering may be less strict.".to_string(),
            workspace_path: None,
            item_key: None,
            details: None,
        });
    }

    let graph = resolve_workspace_graph(
        &repo_root,
        &config,
        request
            .target
            .as_ref()
            .map(|target| target.environment.as_str()),
        &WorkspaceGraphOptions {
            allowed_hosts: None,
            current_namespace,
        },
    )
    .map_err(|error| graph_error(request, error))?;

    let graph = apply_workspace_selection(&config, &graph, &request.selection)
        .map_err(|error| graph_error(request, error))?;

    let order = graph
        .topological_order()
        .map_err(|error| graph_error(request, error))?;
    let dependents = build_dependents(&graph);

    let workspace_snapshots = order
        .iter()
        .map(|workspace_path| WorkspaceSnapshot {
            workspace_path: workspace_path.clone(),
            lifecycle: None,
            materialization: None,
            freshness: None,
        })
        .collect();

    for (index, workspace_path) in order.iter().enumerate() {
        let node = graph
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

    Ok(EngineResponse {
        contract_version: CONTRACT_VERSION,
        operation: request.operation.clone(),
        target: request.target.clone(),
        selection: request.selection.clone(),
        result: OperationResult {
            kind: OperationResultKind::Succeeded,
            summary: format_graph_summary(&graph, &order),
        },
        environment: None,
        workspaces: workspace_snapshots,
        outputs: Default::default(),
        diagnostics,
        metrics: None,
    })
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

fn load_repo_config(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<(PathBuf, PathBuf, yaffle_config::YaffleConfig), EngineError> {
    let config_path = find_yaffle_toml(working_dir).ok_or_else(|| EngineError {
        contract_version: CONTRACT_VERSION,
        operation: Some(request.operation.clone()),
        target: request.target.clone(),
        selection: Some(request.selection.clone()),
        error: yaffle_contracts::ErrorPayload {
            code: "config_not_found".to_string(),
            message: format!(
                "Could not find `yaffle.toml` in '{}' or any parent directory.",
                working_dir.display()
            ),
            details: None,
        },
    })?;

    let raw = fs::read_to_string(&config_path).map_err(|error| EngineError {
        contract_version: CONTRACT_VERSION,
        operation: Some(request.operation.clone()),
        target: request.target.clone(),
        selection: Some(request.selection.clone()),
        error: yaffle_contracts::ErrorPayload {
            code: "config_read_failed".to_string(),
            message: format!(
                "Failed to read '{}' as Yaffle config: {error}",
                config_path.display()
            ),
            details: None,
        },
    })?;

    let config = parse_yaffle_toml(&raw).map_err(|error| EngineError {
        contract_version: CONTRACT_VERSION,
        operation: Some(request.operation.clone()),
        target: request.target.clone(),
        selection: Some(request.selection.clone()),
        error: yaffle_contracts::ErrorPayload {
            code: "config_invalid".to_string(),
            message: format!(
                "Invalid Yaffle config at '{}': {error}",
                config_path.display()
            ),
            details: None,
        },
    })?;

    let repo_root = config_path
        .parent()
        .expect("yaffle.toml should always have a parent directory")
        .to_path_buf();

    Ok((repo_root, config_path, config))
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
        GraphError::UnknownWorkspace { workspace } => EngineError {
            contract_version: CONTRACT_VERSION,
            operation: Some(request.operation.clone()),
            target: request.target.clone(),
            selection: Some(request.selection.clone()),
            error: yaffle_contracts::ErrorPayload {
                code: "invalid_workspace_selection".to_string(),
                message: format!(
                    "Workspace selection references unknown workspace '{}'.",
                    workspace
                ),
                details: Some(BTreeMap::from([(
                    "workspace".to_string(),
                    json!(workspace),
                )])),
            },
        },
        GraphError::WorkspaceNotInEnvironment {
            workspace,
            environment,
        } => EngineError {
            contract_version: CONTRACT_VERSION,
            operation: Some(request.operation.clone()),
            target: request.target.clone(),
            selection: Some(request.selection.clone()),
            error: yaffle_contracts::ErrorPayload {
                code: "workspace_not_in_environment".to_string(),
                message: format!(
                    "Workspace '{}' is not active in environment '{}'.",
                    workspace, environment
                ),
                details: Some(BTreeMap::from([
                    ("workspace".to_string(), json!(workspace)),
                    ("environment".to_string(), json!(environment)),
                ])),
            },
        },
        GraphError::DependencyCycle { cycle_path } => EngineError {
            contract_version: CONTRACT_VERSION,
            operation: Some(request.operation.clone()),
            target: request.target.clone(),
            selection: Some(request.selection.clone()),
            error: yaffle_contracts::ErrorPayload {
                code: "dependency_cycle".to_string(),
                message: format!(
                    "Workspace dependency cycle detected: {}",
                    cycle_path.join(" -> ")
                ),
                details: Some(BTreeMap::from([(
                    "cycle_path".to_string(),
                    json!(cycle_path),
                )])),
            },
        },
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
        (Some(environment), Some(EnvironmentKind::Named)) => format!(
            "environment-resolved graph for '{}' (named, {} workspaces, {} edges)",
            environment,
            order.len(),
            edge_count,
        ),
        (Some(environment), Some(EnvironmentKind::Transient)) => format!(
            "environment-resolved graph for '{}' (transient, {} workspaces, {} edges)",
            environment,
            order.len(),
            edge_count,
        ),
        _ => format!(
            "static repo graph ({} workspaces, {} edges)",
            order.len(),
            edge_count
        ),
    };

    let mut lines = vec![header, String::new()];

    for workspace_path in order {
        let workspace = graph
            .workspace(workspace_path)
            .expect("ordered workspace should exist in resolved graph");

        if workspace.dependencies.is_empty() {
            lines.push(format!("- {}", workspace.path));
        } else {
            lines.push(format!(
                "- {} (depends on: {})",
                workspace.path,
                workspace.dependencies.join(", "),
            ));
        }
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;
    use yaffle_contracts::{EngineOperation, OperationResultKind};

    use super::*;

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

        let response = execute_graph(
            &EngineRequest {
                operation: EngineOperation::Graph,
                target: Some(EnvironmentTarget {
                    environment: "main".to_string(),
                }),
                selection: WorkspaceSelection::default(),
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
            .contains("apps/web/infra (depends on: infra/shared)"),);
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
}
