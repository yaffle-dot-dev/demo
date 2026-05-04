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
    pub activation: Vec<LifecycleHook>,
    pub verification: Vec<LifecycleHook>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleHook {
    pub key: String,
    pub environments: Vec<String>,
    pub kind: LifecycleHookKind,
    pub timeout: Option<String>,
    pub failure: LifecycleFailurePolicy,
    pub scopes: Vec<String>,
    pub request: LifecycleWebhookRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleHookKind {
    Webhook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleFailurePolicy {
    Failed,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleWebhookRequest {
    pub url: String,
    pub method: String,
    pub auth: Option<LifecycleWebhookAuth>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleWebhookAuth {
    pub scheme: LifecycleWebhookAuthScheme,
    pub secret_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleWebhookAuthScheme {
    Bearer,
    HmacSha256,
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

pub fn environment_name_matches_patterns(environment: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|pattern| wildcard_match(pattern, environment))
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
        let activation = normalize_lifecycle_hooks(
            &workspace.path,
            "activation",
            workspace.activation,
            &mut errors,
        );
        let verification = normalize_lifecycle_hooks(
            &workspace.path,
            "verification",
            workspace.verification,
            &mut errors,
        );

        workspaces.push(Workspace {
            path: workspace.path,
            environments,
            variables: workspace.variables.unwrap_or_default(),
            outputs,
            activation,
            verification,
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

fn normalize_lifecycle_hooks(
    workspace_path: &str,
    phase: &str,
    raw: Option<Vec<RawLifecycleHook>>,
    errors: &mut Vec<String>,
) -> Vec<LifecycleHook> {
    let mut hooks = Vec::new();
    let mut seen_keys = BTreeSet::new();

    for hook in raw.unwrap_or_default() {
        if hook.key.trim().is_empty() {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}: lifecycle hook key must not be empty",
            ));
            continue;
        }
        if !seen_keys.insert(hook.key.clone()) {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}: duplicate lifecycle hook key '{}'",
                hook.key,
            ));
            continue;
        }

        let kind = match hook.kind.as_str() {
            "webhook" => LifecycleHookKind::Webhook,
            other => {
                errors.push(format!(
                    "workspaces.{workspace_path}.{phase}.{}: invalid kind '{other}'",
                    hook.key,
                ));
                continue;
            }
        };

        let environments = hook.environments.unwrap_or_else(|| vec!["*".to_string()]);
        if environments.is_empty() || environments.iter().any(|value| value.trim().is_empty()) {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}.{}: environments must contain at least one non-empty pattern",
                hook.key,
            ));
            continue;
        }

        let failure = match hook
            .failure
            .unwrap_or_else(|| "failed".to_string())
            .as_str()
        {
            "failed" => LifecycleFailurePolicy::Failed,
            "degraded" => LifecycleFailurePolicy::Degraded,
            other => {
                errors.push(format!(
                    "workspaces.{workspace_path}.{phase}.{}: invalid failure policy '{other}'",
                    hook.key,
                ));
                continue;
            }
        };

        let scopes = hook.scopes.unwrap_or_else(|| match phase {
            "activation" => vec!["usable".to_string(), "acceptable".to_string()],
            "verification" => vec!["acceptable".to_string()],
            _ => Vec::new(),
        });
        if scopes.is_empty() {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}.{}: scopes must not be empty",
                hook.key,
            ));
            continue;
        }

        let request = match hook.request {
            Some(request) => request,
            None => {
                errors.push(format!(
                    "workspaces.{workspace_path}.{phase}.{}: request is required",
                    hook.key,
                ));
                continue;
            }
        };
        if request.url.trim().is_empty() {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}.{}: request.url must not be empty",
                hook.key,
            ));
            continue;
        }
        let method = request.method.unwrap_or_else(|| "POST".to_string());
        if method != "POST" {
            errors.push(format!(
                "workspaces.{workspace_path}.{phase}.{}: only POST lifecycle webhooks are currently supported",
                hook.key,
            ));
            continue;
        }

        let auth = match request.auth {
            Some(auth) => {
                let scheme = match auth.scheme.as_str() {
                    "bearer" => LifecycleWebhookAuthScheme::Bearer,
                    "hmac_sha256" => LifecycleWebhookAuthScheme::HmacSha256,
                    other => {
                        errors.push(format!(
                            "workspaces.{workspace_path}.{phase}.{}: invalid auth scheme '{other}'",
                            hook.key,
                        ));
                        continue;
                    }
                };
                if auth.secret_ref.trim().is_empty() {
                    errors.push(format!(
                        "workspaces.{workspace_path}.{phase}.{}: auth.secret_ref must not be empty",
                        hook.key,
                    ));
                    continue;
                }
                Some(LifecycleWebhookAuth {
                    scheme,
                    secret_ref: auth.secret_ref,
                })
            }
            None => None,
        };

        hooks.push(LifecycleHook {
            key: hook.key,
            environments,
            kind,
            timeout: hook.timeout,
            failure,
            scopes,
            request: LifecycleWebhookRequest {
                url: request.url,
                method,
                auth,
            },
        });
    }

    hooks
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }

    let parts = pattern.split('*').collect::<Vec<_>>();
    if parts.len() == 1 {
        return pattern == value;
    }

    let mut remainder = value;
    let starts_with_wildcard = pattern.starts_with('*');
    let ends_with_wildcard = pattern.ends_with('*');

    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }

        if index == 0 && !starts_with_wildcard {
            if !remainder.starts_with(part) {
                return false;
            }
            remainder = &remainder[part.len()..];
            continue;
        }

        if index == parts.len() - 1 && !ends_with_wildcard {
            return remainder.ends_with(part);
        }

        if let Some(position) = remainder.find(part) {
            remainder = &remainder[position + part.len()..];
        } else {
            return false;
        }
    }

    true
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
    activation: Option<Vec<RawLifecycleHook>>,
    verification: Option<Vec<RawLifecycleHook>>,
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

#[derive(Debug, Deserialize)]
struct RawLifecycleHook {
    key: String,
    environments: Option<Vec<String>>,
    kind: String,
    timeout: Option<String>,
    failure: Option<String>,
    scopes: Option<Vec<String>>,
    request: Option<RawLifecycleWebhookRequest>,
}

#[derive(Debug, Deserialize)]
struct RawLifecycleWebhookRequest {
    url: String,
    method: Option<String>,
    auth: Option<RawLifecycleWebhookAuth>,
}

#[derive(Debug, Deserialize)]
struct RawLifecycleWebhookAuth {
    scheme: String,
    secret_ref: String,
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

    #[test]
    fn parses_workspace_lifecycle_hooks() {
        let input = r#"
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "apps/web/infra"
environments = ["main"]

  [[workspaces.activation]]
  key = "preview-ready"
  environments = ["pr-*", "main"]
  kind = "webhook"
  timeout = "10m"
  failure = "degraded"
  scopes = ["usable", "acceptable"]

    [workspaces.activation.request]
    url = "http://localhost:8787/hooks/preview-ready"
    method = "POST"

    [workspaces.activation.request.auth]
    scheme = "hmac_sha256"
    secret_ref = "PREVIEW_READY_SECRET"

  [[workspaces.verification]]
  key = "smoke"
  kind = "webhook"

    [workspaces.verification.request]
    url = "https://ci.example.com/hooks/smoke"
"#;

        let config = parse_yaffle_toml(input).expect("config should parse");
        let workspace = &config.workspaces[0];
        assert_eq!(workspace.activation.len(), 1);
        assert_eq!(workspace.verification.len(), 1);
        assert_eq!(workspace.activation[0].environments, vec!["pr-*", "main"]);
        assert_eq!(
            workspace.activation[0].failure,
            LifecycleFailurePolicy::Degraded
        );
        assert_eq!(workspace.verification[0].scopes, vec!["acceptable"]);
        assert_eq!(
            workspace.activation[0]
                .request
                .auth
                .as_ref()
                .unwrap()
                .scheme,
            LifecycleWebhookAuthScheme::HmacSha256
        );
    }

    #[test]
    fn environment_name_patterns_support_wildcards() {
        assert!(environment_name_matches_patterns(
            "pr-42",
            &["pr-*".to_string()]
        ));
        assert!(environment_name_matches_patterns(
            "main",
            &["main".to_string()]
        ));
        assert!(!environment_name_matches_patterns(
            "dev",
            &["main".to_string()]
        ));
    }
}
