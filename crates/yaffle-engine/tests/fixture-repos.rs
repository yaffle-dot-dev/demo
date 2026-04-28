mod support;

use std::env;
use std::sync::{LazyLock, Mutex};

use serde_json::json;
use yaffle_contracts::{EngineOperation, OperationResultKind, WorkspaceSelection};
use yaffle_engine::{execute, EngineRequest, EnvironmentTarget};

use support::{
    copy_fixture_repo, run_tofu_apply, run_tofu_output_json, run_tofu_output_json_for_env,
};

static WAIT_ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[test]
fn graph_dependency_chain_fixture_resolves_expected_order() {
    let repo = copy_fixture_repo("graph-dependency-chain");

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Graph,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("graph fixture should resolve");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert_eq!(
        response
            .workspaces
            .iter()
            .map(|workspace| workspace.workspace_path.as_str())
            .collect::<Vec<_>>(),
        vec!["infra/shared", "apps/api/infra", "apps/web/infra"],
    );
}

#[test]
fn graph_env_split_fixture_filters_named_and_transient_membership() {
    let repo = copy_fixture_repo("graph-env-split");

    let named = execute(
        &EngineRequest {
            operation: EngineOperation::Graph,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("named environment graph should resolve");

    let transient = execute(
        &EngineRequest {
            operation: EngineOperation::Graph,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("transient environment graph should resolve");

    assert_eq!(
        named
            .workspaces
            .iter()
            .map(|workspace| workspace.workspace_path.as_str())
            .collect::<Vec<_>>(),
        vec!["infra/named", "apps/shared/infra"],
    );
    assert_eq!(
        transient
            .workspaces
            .iter()
            .map(|workspace| workspace.workspace_path.as_str())
            .collect::<Vec<_>>(),
        vec!["apps/shared/infra"],
    );
}

#[test]
fn outputs_minimal_single_fixture_can_apply_and_emit_outputs() {
    let repo = copy_fixture_repo("outputs-minimal-single");

    run_tofu_apply(repo.path(), "infra/single");
    let outputs = run_tofu_output_json(repo.path(), "infra/single");

    assert_eq!(outputs["service_name"]["value"], json!("single-service"));
    assert_eq!(outputs["numbers"]["value"], json!([1, 2, 3]));
    assert_eq!(
        outputs["settings"]["value"],
        json!({ "enabled": true, "tier": "test" })
    );

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["infra/single".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs operation should resolve single-workspace outputs");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert_eq!(
        response.outputs["service_name"].value,
        json!("single-service")
    );
    assert_eq!(response.outputs["numbers"].value, json!([1, 2, 3]));
    assert_eq!(
        response.outputs["settings"].value,
        json!({ "enabled": true, "tier": "test" })
    );
    assert!(response.result.summary.contains("resolved 3 output(s)"));
}

#[test]
fn outputs_fixture_returns_empty_map_before_state_exists() {
    let repo = copy_fixture_repo("outputs-minimal-single");

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["infra/single".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs should still execute before state exists");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert!(response.outputs.is_empty());
    assert!(response.result.summary.contains("resolved 0 output(s)"));
}

#[test]
fn status_fixture_reports_absent_before_state_exists() {
    let repo = copy_fixture_repo("outputs-minimal-single");

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
    .expect("status should succeed without existing state");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert_eq!(
        response
            .environment
            .as_ref()
            .and_then(|environment| environment.materialization.as_deref()),
        Some("absent")
    );
    assert_eq!(
        response.workspaces[0].materialization.as_deref(),
        Some("absent")
    );
}

#[test]
fn outputs_remote_state_chain_fixture_supports_upstream_and_downstream_states() {
    let repo = copy_fixture_repo("outputs-remote-state-chain");

    run_tofu_apply(repo.path(), "infra/shared");
    run_tofu_apply(repo.path(), "apps/web/infra");
    let outputs = run_tofu_output_json(repo.path(), "apps/web/infra");

    assert_eq!(
        outputs["base_url"]["value"],
        json!("https://shared.internal")
    );
    assert_eq!(outputs["https_port"]["value"], json!(8443));
    assert_eq!(
        outputs["feature_flags"]["value"],
        json!(["auth", "cdn", "metrics"])
    );

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["apps/web/infra".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs operation should resolve downstream outputs");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert_eq!(
        response.outputs["base_url"].value,
        json!("https://shared.internal")
    );
    assert_eq!(response.outputs["https_port"].value, json!(8443));
    assert_eq!(
        response.outputs["feature_flags"].value,
        json!(["auth", "cdn", "metrics"])
    );
}

#[test]
fn converge_remote_state_chain_fixture_persists_outputs_for_downstream_workspace() {
    let repo = copy_fixture_repo("outputs-remote-state-chain");

    let converge = execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("converge should succeed for remote-state fixture");

    assert_eq!(converge.result.kind, OperationResultKind::Succeeded);
    assert!(converge.result.summary.contains("converged 2 workspace(s)"));

    let direct_outputs = run_tofu_output_json(repo.path(), "apps/web/infra");
    assert_eq!(
        direct_outputs["base_url"]["value"],
        json!("https://shared.internal")
    );

    let outputs = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["apps/web/infra".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs should read state produced by converge");

    assert_eq!(
        outputs.outputs["base_url"].value,
        json!("https://shared.internal")
    );
    assert_eq!(outputs.outputs["https_port"].value, json!(8443));
}

#[test]
fn status_remote_state_chain_fixture_reports_partial_materialization() {
    let repo = copy_fixture_repo("outputs-remote-state-chain");

    run_tofu_apply(repo.path(), "infra/shared");

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
    .expect("status should succeed for partially materialized fixture");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert_eq!(
        response
            .environment
            .as_ref()
            .and_then(|environment| environment.materialization.as_deref()),
        Some("partially_present")
    );
    assert_eq!(
        response
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == "infra/shared")
            .and_then(|workspace| workspace.materialization.as_deref()),
        Some("present")
    );
    assert_eq!(
        response
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == "apps/web/infra")
            .and_then(|workspace| workspace.materialization.as_deref()),
        Some("absent")
    );
}

#[test]
fn status_degrades_when_one_workspace_cannot_initialize() {
    let repo = copy_fixture_repo("status-init-failure-mixed");

    run_tofu_apply(repo.path(), "infra/good");

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
    .expect("status should degrade instead of failing");

    assert_eq!(response.result.kind, OperationResultKind::Degraded);
    assert_eq!(
        response
            .environment
            .as_ref()
            .and_then(|environment| environment.materialization.as_deref()),
        Some("partially_present")
    );
    assert_eq!(
        response
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == "infra/good")
            .and_then(|workspace| workspace.materialization.as_deref()),
        Some("present")
    );
    assert_eq!(
        response
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == "apps/bad/infra")
            .and_then(|workspace| workspace.materialization.as_deref()),
        Some("partially_present")
    );
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.as_deref() == Some("tofu_init_failed")));
}

#[test]
fn converge_environment_vars_fixture_supports_transient_environment_values() {
    let repo = copy_fixture_repo("converge-environment-vars");

    let converge = execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("transient converge should succeed");

    assert_eq!(converge.result.kind, OperationResultKind::Succeeded);

    let direct_outputs = run_tofu_output_json_for_env(repo.path(), "apps/web/infra", "pr-42");
    assert_eq!(
        direct_outputs["environment_descriptor"]["value"],
        json!("pr-42:transient")
    );

    let outputs = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["apps/web/infra".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs should read transient converge state");

    assert_eq!(
        outputs.outputs["environment_descriptor"].value,
        json!("pr-42:transient")
    );
}

#[test]
fn converge_local_module_source_fixture_rewrites_same_repo_module_paths() {
    let repo = copy_fixture_repo("converge-local-module-source");

    let converge = execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("converge should succeed for local module fixture");

    assert_eq!(converge.result.kind, OperationResultKind::Succeeded);
    assert!(!converge
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.as_deref() == Some("auth_host_missing")));

    let outputs = execute(
        &EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection {
                workspaces: vec!["apps/web/infra".to_string()],
            },
            wait_for: None,
        },
        repo.path(),
    )
    .expect("outputs should succeed for local module fixture");

    assert_eq!(
        outputs.outputs["shared_message"].value,
        json!("hello-from-shared")
    );
}

#[test]
fn status_after_transient_converge_reports_present_materialization() {
    let repo = copy_fixture_repo("converge-environment-vars");

    execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("transient converge should succeed");

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Status,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("status should succeed after converge");

    assert_eq!(
        response
            .environment
            .as_ref()
            .and_then(|environment| environment.materialization.as_deref()),
        Some("present")
    );
    assert!(response
        .workspaces
        .iter()
        .all(|workspace| workspace.materialization.as_deref() == Some("present")));
}

#[test]
fn wait_succeeds_for_acceptable_after_transient_converge() {
    let repo = copy_fixture_repo("converge-environment-vars");

    execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("transient converge should succeed");

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Wait,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: Some("acceptable".to_string()),
        },
        repo.path(),
    )
    .expect("wait should succeed for acceptable");

    assert_eq!(response.result.kind, OperationResultKind::Succeeded);
    assert!(response
        .result
        .summary
        .contains("condition 'acceptable' met"));
}

#[test]
fn wait_times_out_when_condition_is_not_met() {
    let repo = copy_fixture_repo("outputs-minimal-single");
    let _guard = WAIT_ENV_LOCK.lock().expect("wait env lock should succeed");
    env::set_var("YAFFLE_WAIT_TIMEOUT_MS", "50");
    env::set_var("YAFFLE_WAIT_POLL_MS", "10");

    let response = execute(
        &EngineRequest {
            operation: EngineOperation::Wait,
            target: Some(EnvironmentTarget {
                environment: "main".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: Some("acceptable".to_string()),
        },
        repo.path(),
    )
    .expect("wait should return a blocked response on timeout");

    env::remove_var("YAFFLE_WAIT_TIMEOUT_MS");
    env::remove_var("YAFFLE_WAIT_POLL_MS");

    assert_eq!(response.result.kind, OperationResultKind::Blocked);
    assert!(response
        .result
        .summary
        .contains("condition 'acceptable' not met"));
}

#[test]
fn destroy_after_converge_clears_materialization() {
    let repo = copy_fixture_repo("converge-environment-vars");

    execute(
        &EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("transient converge should succeed");

    let destroy = execute(
        &EngineRequest {
            operation: EngineOperation::Destroy,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("destroy should succeed");

    assert_eq!(destroy.result.kind, OperationResultKind::Succeeded);
    assert!(destroy.result.summary.contains("destroyed 2 workspace(s)"));

    let status = execute(
        &EngineRequest {
            operation: EngineOperation::Status,
            target: Some(EnvironmentTarget {
                environment: "pr-42".to_string(),
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
        repo.path(),
    )
    .expect("status should succeed after destroy");

    assert_eq!(
        status
            .environment
            .as_ref()
            .and_then(|environment| environment.materialization.as_deref()),
        Some("absent")
    );
}
