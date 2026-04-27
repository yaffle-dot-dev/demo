use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result as AnyhowResult};
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub struct YaffleConfig {
    pub version: u8,
    pub environments: Vec<Environment>,
    pub workspaces: Vec<Workspace>,
    pub cloud: CloudConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Environment {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub path: String,
    pub environments: EnvironmentSelector,
    pub variables: BTreeMap<String, VariableValue>,
    pub outputs: BTreeMap<String, WorkspaceOutputPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvironmentSelector {
    All,
    Named(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum VariableValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceOutputPolicy {
    pub visibility: OutputVisibility,
    pub consumers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputVisibility {
    Internal,
    Public,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CloudConfig {
    pub triggers: Triggers,
    pub approvals: Vec<Approval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Approval {
    pub workspaces: Vec<String>,
    pub environments: Vec<String>,
    pub approvers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Triggers {
    pub github: Option<GitHubTriggers>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitHubTriggers {
    pub push: Vec<PushTrigger>,
    pub pull_request: Vec<PullRequestTrigger>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTrigger {
    pub ref_patterns: Vec<String>,
    pub exclude_ref_patterns: Vec<String>,
    pub environment: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestTrigger {
    pub branch_patterns: Vec<String>,
    pub exclude_branch_patterns: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("Failed to parse yaffle.toml: {0}")]
    ParseToml(String),
    #[error("Invalid yaffle.toml:\n{0}")]
    Validation(String),
}

pub fn validate_environment_name(environment: &str) -> AnyhowResult<()> {
    if environment.trim().is_empty() {
        bail!("environment name must not be empty")
    }

    Ok(())
}

pub fn parse_yaffle_toml(input: &str) -> Result<YaffleConfig, ConfigError> {
    let raw: RawConfig =
        toml::from_str(input).map_err(|error| ConfigError::ParseToml(error.to_string()))?;
    normalize_and_validate(raw)
}

fn normalize_and_validate(raw: RawConfig) -> Result<YaffleConfig, ConfigError> {
    let mut errors = Vec::new();

    if raw.version != 1 {
        errors.push(format!("version: expected 1, got {}", raw.version));
    }

    if raw.triggers.is_some() {
        errors.push(
            "top-level triggers are no longer supported; move them under cloud.triggers"
                .to_string(),
        );
    }

    if raw.approvals.is_some() {
        errors.push(
            "top-level approvals are no longer supported; move them under cloud.approvals"
                .to_string(),
        );
    }

    if raw.workspaces.is_empty() {
        errors.push("workspaces: at least one workspace is required".to_string());
    }

    let environments = raw.environments.unwrap_or_default();
    let declared_environments: BTreeSet<String> = environments
        .iter()
        .map(|environment| environment.name.clone())
        .collect();
    if declared_environments.len() != environments.len() {
        errors.push("environments: duplicate environment names are not allowed".to_string());
    }

    let mut seen_paths = BTreeSet::new();
    let mut workspaces = Vec::new();

    for workspace in raw.workspaces {
        if !seen_paths.insert(workspace.path.clone()) {
            errors.push(format!(
                "workspaces: duplicate workspace path '{}'",
                workspace.path
            ));
        }

        let environments = normalize_environment_selector(workspace.environments);
        if let EnvironmentSelector::Named(names) = &environments {
            for environment in names {
                if !declared_environments.contains(environment) {
                    errors.push(format!(
                        "workspaces.{}: references undeclared environment '{}'",
                        workspace.path, environment
                    ));
                }
            }
        }

        let outputs = normalize_output_policies(&workspace.path, workspace.outputs, &mut errors);

        workspaces.push(Workspace {
            path: workspace.path,
            environments,
            variables: workspace.variables.unwrap_or_default(),
            outputs,
        });
    }

    let cloud = raw.cloud;
    let trigger_root = cloud.as_ref().and_then(|cloud| cloud.triggers.clone());
    let approvals = cloud.and_then(|cloud| cloud.approvals).unwrap_or_default();

    let triggers = normalize_triggers(trigger_root, &declared_environments, &mut errors);

    if !errors.is_empty() {
        return Err(ConfigError::Validation(
            errors
                .into_iter()
                .map(|error| format!("  - {error}"))
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }

    Ok(YaffleConfig {
        version: 1,
        environments,
        workspaces,
        cloud: CloudConfig {
            triggers,
            approvals,
        },
    })
}

fn normalize_environment_selector(raw: RawEnvironmentSelector) -> EnvironmentSelector {
    match raw {
        RawEnvironmentSelector::String(value) if value == "*" => EnvironmentSelector::All,
        RawEnvironmentSelector::String(value) => EnvironmentSelector::Named(vec![value]),
        RawEnvironmentSelector::Array(values) if values.iter().any(|value| value == "*") => {
            EnvironmentSelector::All
        }
        RawEnvironmentSelector::Array(values) => EnvironmentSelector::Named(values),
    }
}

fn normalize_output_policies(
    workspace_path: &str,
    raw: Option<BTreeMap<String, RawWorkspaceOutputPolicy>>,
    errors: &mut Vec<String>,
) -> BTreeMap<String, WorkspaceOutputPolicy> {
    let mut policies = BTreeMap::new();

    for (name, policy) in raw.unwrap_or_default() {
        let visibility = match policy.visibility.as_str() {
            "internal" => OutputVisibility::Internal,
            "public" => OutputVisibility::Public,
            other => {
                errors.push(format!(
                    "workspaces.{workspace_path}.outputs.{name}: invalid visibility '{other}'",
                ));
                continue;
            }
        };

        let consumers = policy.consumers.unwrap_or_default();
        if visibility == OutputVisibility::Public && consumers.is_empty() {
            errors.push(format!(
                "workspaces.{workspace_path}.outputs.{name}: public outputs must declare at least one consumer",
            ));
        }
        if visibility == OutputVisibility::Internal && !consumers.is_empty() {
            errors.push(format!(
                "workspaces.{workspace_path}.outputs.{name}: internal outputs cannot declare consumers",
            ));
        }

        policies.insert(
            name,
            WorkspaceOutputPolicy {
                visibility,
                consumers,
            },
        );
    }

    policies
}

fn normalize_triggers(
    raw: Option<RawTriggers>,
    declared_environments: &BTreeSet<String>,
    errors: &mut Vec<String>,
) -> Triggers {
    let Some(raw) = raw else {
        return Triggers::default();
    };

    let github = raw.github.map(|github| {
        let push = github
            .push
            .unwrap_or_default()
            .into_iter()
            .filter_map(|trigger| {
                let ref_patterns = match (trigger.ref_, trigger.ref_patterns) {
                    (Some(single), None) => vec![single],
                    (None, Some(patterns)) => patterns,
                    (Some(_), Some(_)) => {
                        errors.push("cloud.triggers.github.push: ref and ref_patterns cannot both be set".to_string());
                        return None;
                    }
                    (None, None) => {
                        errors.push("cloud.triggers.github.push: ref or ref_patterns is required".to_string());
                        return None;
                    }
                };

                if !declared_environments.contains(&trigger.environment) {
                    errors.push(format!(
                        "cloud.triggers.github.push: references undeclared environment '{}'",
                        trigger.environment
                    ));
                }

                Some(PushTrigger {
                    ref_patterns,
                    exclude_ref_patterns: trigger.exclude_ref_patterns.unwrap_or_default(),
                    environment: trigger.environment,
                })
            })
            .collect();

        let pull_request = github
            .pull_request
            .unwrap_or_default()
            .into_iter()
            .filter_map(|trigger| {
                let branch_patterns = match (trigger.branch_pattern, trigger.branch_patterns) {
                    (Some(single), None) => vec![single],
                    (None, Some(patterns)) => patterns,
                    (Some(_), Some(_)) => {
                        errors.push(
                            "cloud.triggers.github.pull_request: branch_pattern and branch_patterns cannot both be set"
                                .to_string(),
                        );
                        return None;
                    }
                    (None, None) => {
                        errors.push(
                            "cloud.triggers.github.pull_request: branch_pattern or branch_patterns is required"
                                .to_string(),
                        );
                        return None;
                    }
                };

                Some(PullRequestTrigger {
                    branch_patterns,
                    exclude_branch_patterns: trigger.exclude_branch_patterns.unwrap_or_default(),
                })
            })
            .collect();

        GitHubTriggers { push, pull_request }
    });

    Triggers { github }
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    version: u8,
    environments: Option<Vec<Environment>>,
    workspaces: Vec<RawWorkspace>,
    cloud: Option<RawCloud>,
    triggers: Option<RawTriggers>,
    approvals: Option<Vec<Approval>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawCloud {
    triggers: Option<RawTriggers>,
    approvals: Option<Vec<Approval>>,
}

#[derive(Debug, Deserialize)]
struct RawWorkspace {
    path: String,
    environments: RawEnvironmentSelector,
    variables: Option<BTreeMap<String, VariableValue>>,
    outputs: Option<BTreeMap<String, RawWorkspaceOutputPolicy>>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawEnvironmentSelector {
    String(String),
    Array(Vec<String>),
}

#[derive(Debug, Deserialize)]
struct RawWorkspaceOutputPolicy {
    visibility: String,
    consumers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawTriggers {
    github: Option<RawGitHubTriggers>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawGitHubTriggers {
    push: Option<Vec<RawPushTrigger>>,
    pull_request: Option<Vec<RawPullRequestTrigger>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawPushTrigger {
    #[serde(rename = "ref")]
    ref_: Option<String>,
    ref_patterns: Option<Vec<String>>,
    exclude_ref_patterns: Option<Vec<String>>,
    environment: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawPullRequestTrigger {
    branch_pattern: Option<String>,
    branch_patterns: Option<Vec<String>>,
    exclude_branch_patterns: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_repo_config() {
        let input = include_str!("../../../yaffle.toml");
        let config = parse_yaffle_toml(input).expect("current yaffle.toml should parse");

        assert_eq!(config.version, 1);
        assert_eq!(config.environments[0].name, "main");
        assert!(!config.workspaces.is_empty());
    }

    #[test]
    fn parses_cloud_namespaced_triggers() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/app"
environments = ["main"]

[cloud]

[[cloud.triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"

[[cloud.triggers.github.pull_request]]
branch_patterns = ["*"]
"#;

        let config = parse_yaffle_toml(input).expect("config should parse");
        let github = config
            .cloud
            .triggers
            .github
            .expect("github triggers should exist");
        assert_eq!(github.push.len(), 1);
        assert_eq!(github.pull_request.len(), 1);
    }

    #[test]
    fn parses_cloud_namespaced_approvals() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/app"
environments = ["main"]

[cloud]

[[cloud.approvals]]
workspaces = ["infra/app"]
environments = ["main"]
approvers = ["github:user:alice"]
"#;

        let config = parse_yaffle_toml(input).expect("config should parse");
        assert_eq!(config.cloud.approvals.len(), 1);
        assert_eq!(
            config.cloud.approvals[0].approvers,
            vec!["github:user:alice"]
        );
    }

    #[test]
    fn rejects_legacy_top_level_triggers() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/app"
environments = ["main"]

[[triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"
"#;

        let error = parse_yaffle_toml(input).expect_err("legacy top-level triggers should fail");
        assert!(error
            .to_string()
            .contains("top-level triggers are no longer supported"));
    }

    #[test]
    fn rejects_legacy_top_level_approvals() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/app"
environments = ["main"]

[[approvals]]
workspaces = ["infra/app"]
environments = ["main"]
approvers = ["github:user:alice"]
"#;

        let error = parse_yaffle_toml(input).expect_err("legacy top-level approvals should fail");
        assert!(error
            .to_string()
            .contains("top-level approvals are no longer supported"));
    }

    #[test]
    fn rejects_both_legacy_and_cloud_triggers() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/app"
environments = ["main"]

[cloud]

[[cloud.triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"

[[triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"
"#;

        let error = parse_yaffle_toml(input).expect_err("mixed trigger syntax should fail");
        assert!(error
            .to_string()
            .contains("top-level triggers are no longer supported"));
    }
}
