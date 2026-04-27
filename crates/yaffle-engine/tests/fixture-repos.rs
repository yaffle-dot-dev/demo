mod support;

use serde_json::json;
use yaffle_contracts::{EngineOperation, OperationResultKind, WorkspaceSelection};
use yaffle_engine::{execute, EngineRequest, EnvironmentTarget};

use support::{copy_fixture_repo, run_tofu_apply, run_tofu_output_json};

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
}
