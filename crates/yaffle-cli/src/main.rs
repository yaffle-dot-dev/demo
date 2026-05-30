use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::io::{self, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use yaffle_contracts::{
    EngineError, EngineOperation, EngineResponse, EnvironmentTarget, ErrorPayload, TerraformOutput,
    WorkspaceSelection, CONTRACT_VERSION,
};
use yaffle_engine::{
    build_cloud_cli_authorize_url, clear_local_cloud_auth, compute_local_repo_fingerprint,
    exchange_cloud_cli_login_code, execute, execute_with_progress, get_cloud_cli_capabilities,
    get_cloud_cli_inventory, get_cloud_remote_converge_status, load_local_cloud_auth_status,
    local_first_feature_token_configured, module_api_base_url, prepare_tf_login_exports,
    start_cloud_remote_converge, CloudCliInventory, CloudCliInventoryStatusCount,
    CloudCliLoginResult, CloudRemoteConvergeHandle, CloudRemoteConvergeRequest,
    CloudRemoteConvergeStatus, CloudRemoteLatestRunSummary, ConvergeWorkspacePhase,
    EngineProgressEvent, EngineRequest, LocalCloudAuthStatus, StoredPrincipalCredential,
    StoredPrincipalType, TofuLogStream,
};
use yaffle_graph::{
    environment_kind_for_name, resolve_workspace_graph, EnvironmentKind, ResolvedWorkspaceGraph,
    WorkspaceGraphOptions,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct Color(&'static str);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct Style {
    #[serde(skip_serializing_if = "Option::is_none")]
    fg: Option<Color>,
    #[serde(skip_serializing_if = "is_false")]
    bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    underlined: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for Style {
    fn default() -> Self {
        Self {
            fg: None,
            bold: false,
            underlined: false,
        }
    }
}

impl Style {
    fn default() -> Self {
        Default::default()
    }

    fn fg(mut self, color: Color) -> Self {
        self.fg = Some(color);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Span {
    text: String,
    style: Style,
}

impl Span {
    fn raw(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: Style::default(),
        }
    }

    fn styled(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Line {
    spans: Vec<Span>,
}

impl From<Vec<Span>> for Line {
    fn from(spans: Vec<Span>) -> Self {
        Self { spans }
    }
}

impl From<String> for Line {
    fn from(text: String) -> Self {
        Self {
            spans: vec![Span::raw(text)],
        }
    }
}

impl From<&str> for Line {
    fn from(text: &str) -> Self {
        Self {
            spans: vec![Span::raw(text)],
        }
    }
}

const CLOUD_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const YAFFLE_GREEN_SOFT: Color = Color("#6da323");
const YAFFLE_RED: Color = Color("#fa2d2d");

type CliResult = Result<(), CliFailure>;

#[derive(Debug)]
struct CliFailure {
    json: bool,
    payload: EngineError,
}

impl Display for CliFailure {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.payload.error.message)
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "yaffle",
    version,
    about = "Environment orchestration for Terraform/OpenTofu",
    long_about = "Yaffle CLI\n\nCreate, inspect, and destroy named or transient environments using the canonical Yaffle command surface.",
    after_help = "Examples:\n  yaffle init\n  yaffle converge --env main\n  yaffle converge --env main --plain\n  yaffle outputs --env main\n  yaffle outputs --env main --workspace apps/control-plane/infra\n  yaffle graph --env pr-7\n  eval \"$(yaffle tf login --env main --workspace apps/web/infra)\"\n  yaffle cloud login"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Initialize or scaffold repo-native Yaffle config
    Init,
    /// Converge an environment to the current desired configuration and revision
    Converge(ConvergeCommand),
    /// Destroy an environment or a targeted subset in dependency-safe reverse order
    Destroy(TargetedCommand),
    /// Show environment conditions, materialization, and derived status information
    Status(EnvironmentOnlyCommand),
    /// Wait for an environment condition to become met or settled
    Wait(WaitCommand),
    /// Read outputs for a workspace in an environment
    Outputs(OutputsCommand),
    /// Inspect the static or environment-resolved workspace dependency graph
    Graph(GraphCommand),
    /// Diagnose local or cloud prerequisites, configuration, and capability problems
    Doctor,
    #[command(subcommand)]
    /// Bootstrap raw tofu access for the current shell
    Tf(TfCommands),
    /// Generate shell completion scripts for the static CLI surface
    Completion(CompletionCommand),
    #[command(subcommand)]
    Cloud(CloudCommands),
}

#[derive(Debug, Args)]
struct TargetedCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Workspace path to target. Repeat to select multiple workspaces.
    #[arg(long = "workspace")]
    workspaces: Vec<String>,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct ConvergeCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Workspace path to target. Repeat to select multiple workspaces.
    #[arg(long = "workspace")]
    workspaces: Vec<String>,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
    /// Render plain output instead of the interactive converge TUI
    #[arg(long)]
    plain: bool,
    /// Run the converge through Yaffle's hosted paid-cloud execution path
    #[arg(long)]
    remote: bool,
}

#[derive(Debug, Args)]
struct EnvironmentOnlyCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct WaitCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Environment condition to wait for
    #[arg(long = "for")]
    condition: String,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct OutputsCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Workspace path to narrow to. Repeat to select multiple workspaces.
    #[arg(long = "workspace")]
    workspaces: Vec<String>,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct GraphCommand {
    /// Optional environment name for environment-resolved graph output
    #[arg(long)]
    env: Option<String>,
    /// Emit machine-readable JSON output
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct CompletionCommand {
    /// Shell to generate completion for
    #[arg(value_enum)]
    shell: Shell,
}

#[derive(Debug, Subcommand)]
enum CloudCommands {
    /// Authenticate the operator to Yaffle Cloud
    Login,
    /// Remove local Yaffle Cloud authentication state
    Logout,
    /// Show current Yaffle Cloud authentication/backend status
    Status,
}

#[derive(Debug, Subcommand)]
enum TfCommands {
    /// Emit shell exports so raw tofu can resolve Yaffle-hosted output modules
    Login(TfLoginCommand),
}

#[derive(Debug, Args)]
struct TfLoginCommand {
    /// Environment name
    #[arg(long)]
    env: String,
    /// Workspace path
    #[arg(long = "workspace")]
    workspace: String,
}

fn main() {
    if let Err(error) = run() {
        if error.json {
            match serde_json::to_string_pretty(&error.payload) {
                Ok(value) => println!("{value}"),
                Err(_) => eprintln!("Error: {}", error.payload.error.message),
            }
        } else {
            eprintln!("Error: {error}");
        }
        std::process::exit(1);
    }
}

fn run() -> CliResult {
    let cli = Cli::parse();

    match cli.command {
        None => run_shell(),
        Some(Commands::Init) => print_placeholder(
            "init",
            "Initialize or scaffold repo-native Yaffle config",
            false,
        ),
        Some(Commands::Converge(command)) => run_converge(command),
        Some(Commands::Destroy(command)) => {
            run_targeted_operation(EngineOperation::Destroy, command)
        }
        Some(Commands::Status(command)) => {
            run_environment_operation(EngineOperation::Status, command)
        }
        Some(Commands::Wait(command)) => run_wait(command),
        Some(Commands::Outputs(command)) => run_outputs(command),
        Some(Commands::Graph(command)) => run_graph(command),
        Some(Commands::Doctor) => run_doctor(),
        Some(Commands::Tf(command)) => run_tf(command),
        Some(Commands::Completion(command)) => run_completion(command),
        Some(Commands::Cloud(command)) => run_cloud(command),
    }
}

fn run_targeted_operation(operation: EngineOperation, command: TargetedCommand) -> CliResult {
    run_engine_request(
        command.json,
        EngineRequest {
            operation,
            target: Some(EnvironmentTarget {
                environment: command.env,
            }),
            selection: WorkspaceSelection {
                workspaces: command.workspaces,
            },
            wait_for: None,
        },
    )
}

fn run_converge(command: ConvergeCommand) -> CliResult {
    let request = EngineRequest {
        operation: EngineOperation::Converge,
        target: Some(EnvironmentTarget {
            environment: command.env,
        }),
        selection: WorkspaceSelection {
            workspaces: command.workspaces,
        },
        wait_for: None,
    };

    if command.remote {
        return run_remote_converge(command.json, command.plain, request);
    }

    if command.json || command.plain || !should_use_converge_tui() {
        return run_engine_request(command.json, request);
    }

    run_shell_with_startup(Some(request))
}

fn run_remote_converge(json: bool, _plain: bool, request: EngineRequest) -> CliResult {
    let working_dir = current_working_directory(json, &request)?;
    let principal = load_account_cloud_principal(json, &request)?;
    let remote_request = build_remote_converge_request(&working_dir, &request)?;
    let handle = start_cloud_remote_converge(&principal, &remote_request).map_err(|error| {
        command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "remote_converge_start_failed",
            error.friendly_message(),
        )
    })?;

    let status = follow_remote_converge(json, &request, &principal, &handle)?;

    if json {
        let rendered = serde_json::to_string_pretty(&status).map_err(|error| {
            command_error(
                json,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "json_render_failed",
                format!("Failed to render hosted converge result as JSON: {error}"),
            )
        })?;
        println!("{rendered}");
        return Ok(());
    }

    if remote_status_failed(&status) {
        return Err(command_error(
            json,
            Some(request.operation),
            request.target,
            Some(request.selection),
            "remote_converge_failed",
            remote_failure_message(&status),
        ));
    }

    println!(
        "Hosted converge completed successfully for {} (run group {}).",
        status.run_group.environment_name, status.run_group.id
    );
    Ok(())
}

fn should_use_converge_tui() -> bool {
    io::stdout().is_terminal() && io::stderr().is_terminal()
}

fn load_account_cloud_principal(
    json: bool,
    request: &EngineRequest,
) -> Result<StoredPrincipalCredential, CliFailure> {
    let status = load_local_cloud_auth_status().map_err(|error| {
        command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "cloud_auth_unavailable",
            format!("Failed to read Yaffle Cloud auth state: {error}"),
        )
    })?;

    if status.expired {
        return Err(command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "cloud_auth_expired",
            "Your Yaffle Cloud account session has expired. Run `yaffle cloud login` again before using `--remote`.",
        ));
    }

    let Some(principal) = status.stored_principal else {
        return Err(command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "cloud_auth_required",
            "Remote converge requires a Yaffle Cloud account session. Run `yaffle cloud login` first.",
        ));
    };

    if principal.principal_type != StoredPrincipalType::Account {
        return Err(command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "paid_cloud_required",
            "Remote converge requires an account-backed paid-cloud session. Run `yaffle cloud login` first.",
        ));
    }

    if !local_first_feature_token_configured() {
        return Err(command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "feature_token_required",
            "Remote converge requires `YAFFLE_LOCAL_FIRST_FEATURE_TOKEN` so the CLI can talk to Yaffle Cloud's CLI APIs.",
        ));
    }

    Ok(principal)
}

fn build_remote_converge_request(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<CloudRemoteConvergeRequest, CliFailure> {
    ensure_clean_git_worktree(working_dir, request)?;
    let repo_full_name = infer_repo_full_name(working_dir, request)?;
    let head_sha = current_git_head_sha(working_dir, request)?;
    let git_ref = resolve_remote_git_ref(working_dir, request, &head_sha)?;
    let workspace_paths = request.selection.workspaces.clone();
    let environment_name = request
        .target
        .as_ref()
        .map(|target| target.environment.clone())
        .expect("remote converge requires a target environment");
    let local_repo_fingerprint = compute_local_repo_fingerprint(working_dir).map_err(|error| {
        command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "repo_fingerprint_failed",
            format!("Failed to compute the local repo fingerprint for remote converge: {error}"),
        )
    })?;
    let canonical_repo_namespace = repo_full_name.replace('/', "--");

    Ok(CloudRemoteConvergeRequest {
        repo_full_name,
        canonical_repo_namespace,
        local_repo_fingerprint,
        environment_name,
        git_ref,
        head_sha,
        workspace_paths,
    })
}

fn follow_remote_converge(
    json: bool,
    request: &EngineRequest,
    principal: &StoredPrincipalCredential,
    handle: &CloudRemoteConvergeHandle,
) -> Result<CloudRemoteConvergeStatus, CliFailure> {
    if !json {
        println!(
            "Hosted converge queued for {} (run group {}).",
            handle.environment_name, handle.run_group_id
        );
        println!("Selected workspaces: {}", handle.workspace_paths.join(", "));
        if let Some(web_url) = &handle.web_url {
            println!("View in Yaffle: {web_url}");
        }
    }

    let mut last_snapshot: Option<CloudRemoteConvergeStatus> = None;

    loop {
        let snapshot =
            get_cloud_remote_converge_status(principal, &handle.run_group_id).map_err(|error| {
                command_error(
                    json,
                    Some(request.operation.clone()),
                    request.target.clone(),
                    Some(request.selection.clone()),
                    "remote_converge_follow_failed",
                    error.friendly_message(),
                )
            })?;

        if !json {
            maybe_print_remote_snapshot(last_snapshot.as_ref(), &snapshot);
        }

        if remote_status_terminal(&snapshot.run_group.status) {
            return Ok(snapshot);
        }

        last_snapshot = Some(snapshot);
        thread::sleep(Duration::from_secs(2));
    }
}

fn run_remote_converge_for_tui(
    working_dir: PathBuf,
    request: EngineRequest,
    tx: mpsc::Sender<ConvergeTuiEvent>,
) -> Result<CloudRemoteConvergeStatus, String> {
    let principal =
        load_account_cloud_principal(false, &request).map_err(|error| error.to_string())?;
    let remote_request =
        build_remote_converge_request(&working_dir, &request).map_err(|error| error.to_string())?;
    let handle = start_cloud_remote_converge(&principal, &remote_request)
        .map_err(|error| error.friendly_message())?;
    let _ = tx.send(ConvergeTuiEvent::RemoteQueued(handle.clone()));

    loop {
        let snapshot = get_cloud_remote_converge_status(&principal, &handle.run_group_id)
            .map_err(|error| error.friendly_message())?;
        let _ = tx.send(ConvergeTuiEvent::RemoteStatus(snapshot.clone()));

        if remote_status_terminal(&snapshot.run_group.status) {
            return Ok(snapshot);
        }

        thread::sleep(Duration::from_secs(2));
    }
}

fn maybe_print_remote_snapshot(
    previous: Option<&CloudRemoteConvergeStatus>,
    current: &CloudRemoteConvergeStatus,
) {
    if previous.map(remote_snapshot_signature).as_deref()
        == Some(remote_snapshot_signature(current).as_str())
    {
        return;
    }

    println!(
        "[hosted] run group {} -> {}",
        current.run_group.id, current.run_group.status
    );
    for deployment in &current.deployments {
        let run_label = deployment.latest_run.as_ref().map(remote_run_label);
        match run_label {
            Some(run_label) => println!(
                "  - {}: {} ({})",
                deployment.workspace_path, deployment.status, run_label
            ),
            None => println!("  - {}: {}", deployment.workspace_path, deployment.status),
        }
    }
}

fn remote_run_label(run: &CloudRemoteLatestRunSummary) -> String {
    if run.run_type == "apply" && run.status == "skipped" {
        return "apply not needed".to_string();
    }

    format!("{} {}", run.run_type, run.status)
}

fn remote_snapshot_signature(snapshot: &CloudRemoteConvergeStatus) -> String {
    let mut value = format!("{}:{}", snapshot.run_group.id, snapshot.run_group.status);
    for deployment in &snapshot.deployments {
        value.push_str(&format!(
            "|{}:{}:{}:{}",
            deployment.workspace_path,
            deployment.status,
            deployment
                .latest_run
                .as_ref()
                .map(|run| run.run_type.as_str())
                .unwrap_or("-"),
            deployment
                .latest_run
                .as_ref()
                .map(|run| run.status.as_str())
                .unwrap_or("-"),
        ));
    }
    value
}

fn remote_status_terminal(status: &str) -> bool {
    matches!(status, "success" | "failed" | "partial")
}

fn remote_status_failed(status: &CloudRemoteConvergeStatus) -> bool {
    matches!(status.run_group.status.as_str(), "failed" | "partial")
}

fn remote_failure_message(status: &CloudRemoteConvergeStatus) -> String {
    let failing = status.deployments.iter().find(|deployment| {
        deployment.status == "failed"
            || deployment
                .latest_run
                .as_ref()
                .is_some_and(|run| run.status == "failed")
    });

    if let Some(deployment) = failing {
        if let Some(run) = &deployment.latest_run {
            if let Some(log_output) = &run.log_output {
                let trimmed = log_output.trim();
                if !trimmed.is_empty() {
                    return format!(
                        "Hosted converge failed in {} during {}:\n{}",
                        deployment.workspace_path, run.run_type, trimmed
                    );
                }
            }
            if let Some(error) = &run.error_message {
                return format!(
                    "Hosted converge failed in {} during {}: {}",
                    deployment.workspace_path, run.run_type, error
                );
            }
        }
        return format!("Hosted converge failed in {}.", deployment.workspace_path);
    }

    format!(
        "Hosted converge finished with status '{}'.",
        status.run_group.status
    )
}

fn ensure_clean_git_worktree(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<(), CliFailure> {
    let output = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "git_status_failed",
                format!("Failed to inspect git working tree state: {error}"),
            )
        })?;

    if !output.status.success() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "git_status_failed",
            "Failed to inspect git working tree state for remote converge.",
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "dirty_worktree_not_supported",
            "Remote converge currently requires a clean working tree.",
        ));
    }

    Ok(())
}

fn infer_repo_full_name(working_dir: &Path, request: &EngineRequest) -> Result<String, CliFailure> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "repo_remote_unavailable",
                format!("Failed to resolve git remote origin: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "repo_remote_unavailable",
            "Could not resolve git remote origin for remote converge.",
        ));
    }

    let remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_github_repo_full_name(&remote).ok_or_else(|| {
        command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "repo_identity_unavailable",
            "Remote converge currently requires a GitHub origin remote.",
        )
    })
}

fn parse_github_repo_full_name(remote: &str) -> Option<String> {
    let github_prefix = remote.split("github.com").nth(1)?;
    let trimmed = github_prefix
        .trim_start_matches(':')
        .trim_start_matches('/');
    let trimmed = trimmed.trim_end_matches(".git");
    let mut parts = trimmed.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(format!("{owner}/{repo}"))
}

fn current_git_head_sha(working_dir: &Path, request: &EngineRequest) -> Result<String, CliFailure> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "git_sha_unavailable",
                format!("Failed to resolve git HEAD SHA for remote converge: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "git_sha_unavailable",
            "Failed to resolve git HEAD SHA for remote converge.",
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_remote_git_ref(
    working_dir: &Path,
    request: &EngineRequest,
    local_head_sha: &str,
) -> Result<String, CliFailure> {
    let local_branch_ref = current_git_symbolic_ref(working_dir, request)?;
    if let Some(upstream_ref) = current_git_upstream_ref(working_dir, request)? {
        let upstream_sha = resolve_git_ref_sha(working_dir, request, &upstream_ref)?;
        if upstream_sha != local_head_sha {
            return Err(command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "unpushed_commits_not_supported",
                "Remote converge currently requires local HEAD to match the remote ref that will execute in the cloud. Push or fast-forward before using `--remote`.",
            ));
        }

        if let Some(mapped) = map_origin_remote_ref_to_head_ref(&upstream_ref) {
            return Ok(mapped);
        }
    }

    let remote_refs = list_origin_remote_refs(working_dir, request)?;
    if let Some(local_branch_ref) = local_branch_ref.as_deref() {
        let branch_name = local_branch_ref.trim_start_matches("refs/heads/");
        let candidate_remote_ref = format!("refs/remotes/origin/{branch_name}");
        if remote_refs
            .iter()
            .any(|(remote_ref, sha)| remote_ref == &candidate_remote_ref && sha == local_head_sha)
        {
            return Ok(local_branch_ref.to_string());
        }
    }

    let mut matching_remote_refs = remote_refs
        .into_iter()
        .filter(|(remote_ref, sha)| {
            sha == local_head_sha && remote_ref != "refs/remotes/origin/HEAD"
        })
        .filter_map(|(remote_ref, _)| map_origin_remote_ref_to_head_ref(&remote_ref))
        .collect::<Vec<_>>();
    matching_remote_refs.sort();
    matching_remote_refs.dedup();

    match matching_remote_refs.as_slice() {
        [resolved_ref] => Ok(resolved_ref.clone()),
        [] => Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "remote_ref_unavailable",
            "Remote converge currently requires HEAD to be pushed to a resolvable origin branch or tag ref.",
        )),
        refs => Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "remote_ref_ambiguous",
            format!(
                "Remote converge found multiple origin refs for HEAD ({}). Check out a branch or disambiguate the ref before using `--remote`.",
                refs.join(", ")
            ),
        )),
    }
}

fn current_git_symbolic_ref(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<Option<String>, CliFailure> {
    let output = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "git_ref_unavailable",
                format!("Failed to resolve git ref metadata for remote converge: {error}"),
            )
        })?;

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

fn current_git_upstream_ref(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<Option<String>, CliFailure> {
    let output = Command::new("git")
        .args(["rev-parse", "--symbolic-full-name", "@{upstream}"])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "upstream_ref_unavailable",
                format!("Failed to inspect upstream ref metadata for remote converge: {error}"),
            )
        })?;

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

fn resolve_git_ref_sha(
    working_dir: &Path,
    request: &EngineRequest,
    git_ref: &str,
) -> Result<String, CliFailure> {
    let output = Command::new("git")
        .args(["rev-parse", git_ref])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "git_ref_unavailable",
                format!("Failed to resolve git ref '{git_ref}' for remote converge: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "git_ref_unavailable",
            format!("Failed to resolve git ref '{git_ref}' for remote converge."),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn list_origin_remote_refs(
    working_dir: &Path,
    request: &EngineRequest,
) -> Result<Vec<(String, String)>, CliFailure> {
    let output = Command::new("git")
        .args([
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/origin",
        ])
        .current_dir(working_dir)
        .output()
        .map_err(|error| {
            command_error(
                false,
                Some(request.operation.clone()),
                request.target.clone(),
                Some(request.selection.clone()),
                "remote_ref_unavailable",
                format!("Failed to inspect origin refs for remote converge: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(command_error(
            false,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "remote_ref_unavailable",
            "Failed to inspect origin refs for remote converge.",
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_git_remote_ref_line)
        .collect())
}

fn parse_git_remote_ref_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let git_ref = parts.next()?.trim();
    let sha = parts.next()?.trim();
    if git_ref.is_empty() || sha.is_empty() {
        return None;
    }
    Some((git_ref.to_string(), sha.to_string()))
}

fn map_origin_remote_ref_to_head_ref(remote_ref: &str) -> Option<String> {
    remote_ref
        .strip_prefix("refs/remotes/origin/")
        .filter(|value| !value.is_empty() && *value != "HEAD")
        .map(|suffix| format!("refs/heads/{suffix}"))
}

fn run_shell() -> CliResult {
    run_shell_with_startup(None)
}

fn run_shell_with_startup(startup_converge: Option<EngineRequest>) -> CliResult {
    if !should_use_converge_tui() {
        let mut command = Cli::command();
        command.print_help().map_err(|error| {
            command_error(
                false,
                None,
                None,
                None,
                "help_render_failed",
                format!("Failed to render CLI help: {error}"),
            )
        })?;
        println!();
        return Ok(());
    }

    let working_dir = std::env::current_dir().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "current_directory_unavailable",
            format!("Failed to resolve the current working directory: {error}"),
        )
    })?;
    let mut app = LocalAppState::load(&working_dir)?;
    if let Some(request) = startup_converge {
        app.open_environment_for_request(&request)?;
        app.start_converge_in_place(request)?;
    }

    run_opentui_shell(app)
}

fn run_opentui_shell(app: LocalAppState) -> CliResult {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_server_failed",
            format!("Failed to bind the Yaffle OpenTUI IPC server: {error}"),
        )
    })?;
    listener.set_nonblocking(true).map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_server_failed",
            format!("Failed to configure the Yaffle OpenTUI IPC server: {error}"),
        )
    })?;
    let server_addr = listener.local_addr().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_server_failed",
            format!("Failed to resolve the Yaffle OpenTUI IPC server address: {error}"),
        )
    })?;
    let server_url = format!("http://{server_addr}");
    let token = generate_pkce_verifier().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_server_failed",
            format!("Failed to generate an OpenTUI IPC session token: {error}"),
        )
    })?;

    let app_state = Arc::new(Mutex::new(app));
    let shutdown = Arc::new(AtomicBool::new(false));
    let server_error = Arc::new(Mutex::new(None::<CliFailure>));
    let server_state = Arc::clone(&app_state);
    let server_shutdown = Arc::clone(&shutdown);
    let server_error_sink = Arc::clone(&server_error);
    let server_token = token.clone();
    let server_thread = thread::spawn(move || {
        serve_opentui_requests(
            listener,
            server_state,
            server_shutdown,
            server_error_sink,
            server_token,
        );
    });

    let renderer_path = resolve_opentui_renderer_path()?;
    let bun = std::env::var("YAFFLE_OPENTUI_BUN").unwrap_or_else(|_| "bun".to_string());
    let status = Command::new(&bun)
        .arg("run")
        .arg(&renderer_path)
        .env("YAFFLE_TUI_SERVER", &server_url)
        .env("YAFFLE_TUI_TOKEN", &token)
        .status()
        .map_err(|error| {
            shutdown.store(true, Ordering::SeqCst);
            command_error(
                false,
                None,
                None,
                None,
                "opentui_renderer_failed",
                format!(
                    "Failed to launch the Yaffle OpenTUI renderer with `{bun}` at '{}': {error}",
                    renderer_path.display(),
                ),
            )
        })?;

    shutdown.store(true, Ordering::SeqCst);
    let _ = server_thread.join();

    if let Ok(mut error) = server_error.lock() {
        if let Some(error) = error.take() {
            return Err(error);
        }
    }

    if !status.success() {
        return Err(command_error(
            false,
            None,
            None,
            None,
            "opentui_renderer_failed",
            format!("Yaffle's OpenTUI renderer exited with status {status}."),
        ));
    }

    Ok(())
}

fn resolve_opentui_renderer_path() -> Result<PathBuf, CliFailure> {
    if let Ok(path) = std::env::var("YAFFLE_OPENTUI_RENDERER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(command_error(
            false,
            None,
            None,
            None,
            "opentui_renderer_missing",
            format!(
                "YAFFLE_OPENTUI_RENDERER points at '{}', but that file does not exist.",
                path.display(),
            ),
        ));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [manifest_dir.join("../../packages/cli/src/main.tsx")];

    for candidate in candidates {
        if candidate.is_file() {
            return candidate.canonicalize().map_err(|error| {
                command_error(
                    false,
                    None,
                    None,
                    None,
                    "opentui_renderer_missing",
                    format!(
                        "Failed to resolve OpenTUI renderer path '{}': {error}",
                        candidate.display(),
                    ),
                )
            });
        }
    }

    Err(command_error(
        false,
        None,
        None,
        None,
        "opentui_renderer_missing",
        "Could not find the Yaffle OpenTUI renderer. Run from the repo root or set YAFFLE_OPENTUI_RENDERER.",
    ))
}

fn serve_opentui_requests(
    listener: TcpListener,
    app_state: Arc<Mutex<LocalAppState>>,
    shutdown: Arc<AtomicBool>,
    server_error: Arc<Mutex<Option<CliFailure>>>,
    token: String,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Err(error) = stream.set_nonblocking(false) {
                    let _ = write_text_response(
                        &mut stream,
                        500,
                        &format!("Failed to prepare OpenTUI IPC stream: {error}"),
                    );
                    continue;
                }
                if let Err(error) =
                    handle_opentui_request(&mut stream, &app_state, &shutdown, token.as_str())
                {
                    let _ = write_text_response(&mut stream, 500, &error.payload.error.message);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(16));
            }
            Err(error) => {
                if let Ok(mut sink) = server_error.lock() {
                    *sink = Some(command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_server_failed",
                        format!("Yaffle OpenTUI IPC server failed: {error}"),
                    ));
                }
                shutdown.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn handle_opentui_request(
    stream: &mut TcpStream,
    app_state: &Arc<Mutex<LocalAppState>>,
    shutdown: &Arc<AtomicBool>,
    token: &str,
) -> Result<(), CliFailure> {
    let request = read_http_request(stream).map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_server_failed",
            format!("Failed to read OpenTUI IPC request: {error}"),
        )
    })?;

    if request.path != "/health"
        && request
            .headers
            .get("x-yaffle-tui-token")
            .map(String::as_str)
            != Some(token)
    {
        let _ = write_text_response(stream, 401, "unauthorized");
        return Ok(());
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => write_json_response(
            stream,
            200,
            &serde_json::json!({ "data": { "status": "ok" } }),
        )
        .map_err(|error| opentui_response_error(error)),
        ("GET", "/snapshot") => {
            let snapshot = {
                let mut app = app_state.lock().map_err(|_| {
                    command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_state_failed",
                        "Yaffle OpenTUI state lock was poisoned.",
                    )
                })?;
                app.tick();
                render_shell_snapshot(&app)
            };
            write_json_response(stream, 200, &snapshot).map_err(opentui_response_error)
        }
        ("POST", "/key") => {
            let event =
                serde_json::from_slice::<OpenTuiKeyEvent>(&request.body).map_err(|error| {
                    command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_event_failed",
                        format!("OpenTUI sent an invalid key event: {error}"),
                    )
                })?;
            let Some(key) = event.to_tui_key() else {
                return write_json_response(
                    stream,
                    200,
                    &serde_json::json!({ "data": { "action": null } }),
                )
                .map_err(opentui_response_error);
            };
            let action = {
                let mut app = app_state.lock().map_err(|_| {
                    command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_state_failed",
                        "Yaffle OpenTUI state lock was poisoned.",
                    )
                })?;
                app.handle_key(key)?
            };
            if matches!(action, Some(ShellAction::Quit)) {
                shutdown.store(true, Ordering::SeqCst);
                return write_json_response(
                    stream,
                    200,
                    &serde_json::json!({ "data": { "action": "quit" } }),
                )
                .map_err(opentui_response_error);
            }
            write_json_response(
                stream,
                200,
                &serde_json::json!({ "data": { "action": null } }),
            )
            .map_err(opentui_response_error)
        }
        ("POST", "/graph") => {
            let event =
                serde_json::from_slice::<OpenTuiGraphEvent>(&request.body).map_err(|error| {
                    command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_event_failed",
                        format!("OpenTUI sent an invalid graph event: {error}"),
                    )
                })?;
            {
                let mut app = app_state.lock().map_err(|_| {
                    command_error(
                        false,
                        None,
                        None,
                        None,
                        "tui_state_failed",
                        "Yaffle OpenTUI state lock was poisoned.",
                    )
                })?;
                app.handle_graph_event(event);
            }
            write_json_response(
                stream,
                200,
                &serde_json::json!({ "data": { "action": null } }),
            )
            .map_err(opentui_response_error)
        }
        ("POST", "/shutdown") => {
            shutdown.store(true, Ordering::SeqCst);
            write_json_response(
                stream,
                200,
                &serde_json::json!({ "data": { "action": "quit" } }),
            )
            .map_err(opentui_response_error)
        }
        _ => write_text_response(stream, 404, "not found").map_err(opentui_response_error),
    }
}

fn opentui_response_error(error: io::Error) -> CliFailure {
    command_error(
        false,
        None,
        None,
        None,
        "tui_server_failed",
        format!("Failed to write OpenTUI IPC response: {error}"),
    )
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> io::Result<HttpRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);

        if header_end.is_none() {
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let end = position + 4;
                header_end = Some(end);
                let header_text = String::from_utf8_lossy(&buffer[..position]);
                content_length = header_text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
            }
        }

        if let Some(end) = header_end {
            if buffer.len() >= end + content_length {
                break;
            }
        }

        if buffer.len() > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "OpenTUI IPC request exceeded 1 MiB",
            ));
        }
    }

    let Some(header_end) = header_end else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "OpenTUI IPC request was missing HTTP headers",
        ));
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end - 4]);
    let mut lines = header_text.lines();
    let request_line = lines.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "OpenTUI IPC request was missing a request line",
        )
    })?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("GET").to_string();
    let raw_path = request_parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or(raw_path).to_string();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let body_end = (header_end + content_length).min(buffer.len());

    Ok(HttpRequest {
        method,
        path,
        headers,
        body: buffer[header_end..body_end].to_vec(),
    })
}

fn write_json_response<T: Serialize>(
    stream: &mut TcpStream,
    status: u16,
    value: &T,
) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?;
    write_http_response(stream, status, "application/json; charset=utf-8", &body)
}

fn write_text_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    write_http_response(stream, status, "text/plain; charset=utf-8", body.as_bytes())
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        http_status_text(status),
        body.len(),
    );
    stream.write_all(response.as_bytes())?;
    stream.write_all(body)
}

fn http_status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTuiKeyEvent {
    name: String,
    #[serde(default)]
    ctrl: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTuiGraphEvent {
    node_id: String,
    action: OpenTuiGraphAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OpenTuiGraphAction {
    Select,
    Toggle,
}

impl OpenTuiKeyEvent {
    fn to_tui_key(&self) -> Option<TuiKey> {
        if self.ctrl && self.name == "c" {
            return Some(TuiKey::Char('q'));
        }

        match self.name.as_str() {
            "up" => Some(TuiKey::Up),
            "down" => Some(TuiKey::Down),
            "left" => Some(TuiKey::Left),
            "right" => Some(TuiKey::Right),
            "enter" | "return" => Some(TuiKey::Enter),
            "escape" => Some(TuiKey::Esc),
            "tab" => Some(TuiKey::Tab),
            "space" => Some(TuiKey::Space),
            value if value.chars().count() == 1 => value.chars().next().map(TuiKey::Char),
            _ => None,
        }
    }
}

#[derive(Debug)]
enum ConvergeTuiEvent {
    Progress(EngineProgressEvent),
    Finished(Result<EngineResponse, EngineError>),
    RemoteQueued(CloudRemoteConvergeHandle),
    RemoteStatus(CloudRemoteConvergeStatus),
    RemoteFinished(Result<CloudRemoteConvergeStatus, String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceRunState {
    Pending,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone)]
struct WorkspaceConvergeView {
    path: String,
    state: WorkspaceRunState,
    phase: Option<ConvergeWorkspacePhase>,
}

#[derive(Debug, Clone)]
struct ConvergeTuiState {
    environment_name: String,
    workspaces: Vec<WorkspaceConvergeView>,
    dag: String,
    workspace_logs: BTreeMap<String, Vec<WorkspaceLogLine>>,
    workspace_outputs: BTreeMap<String, BTreeMap<String, TerraformOutput>>,
    spinner_index: usize,
    summary: String,
    detail: String,
    failure_message: Option<String>,
    active_workspace: Option<String>,
    selected_workspace_index: usize,
    follow_running_workspace: bool,
}

#[derive(Debug, Clone)]
struct WorkspaceLogLine {
    stream: TofuLogStream,
    text: String,
}

impl ConvergeTuiState {
    fn new(environment_name: String) -> Self {
        Self {
            environment_name,
            workspaces: Vec::new(),
            dag: String::new(),
            workspace_logs: BTreeMap::new(),
            workspace_outputs: BTreeMap::new(),
            spinner_index: 0,
            summary: "Resolving workspace graph".to_string(),
            detail: "Yaffle is preparing a local converge run.".to_string(),
            failure_message: None,
            active_workspace: None,
            selected_workspace_index: 0,
            follow_running_workspace: true,
        }
    }

    fn apply_progress(&mut self, event: EngineProgressEvent) {
        match event {
            EngineProgressEvent::ConvergePlan {
                environment_name,
                workspaces,
                dag,
            } => {
                self.environment_name = environment_name;
                self.dag = dag;
                self.workspaces = workspaces
                    .into_iter()
                    .map(|path| WorkspaceConvergeView {
                        path,
                        state: WorkspaceRunState::Pending,
                        phase: None,
                    })
                    .collect();
                self.selected_workspace_index = 0;
                self.follow_running_workspace = true;
                self.summary = format!("Converging {} workspace(s)", self.workspaces.len());
                self.detail = "Waiting on the first workspace to start.".to_string();
            }
            EngineProgressEvent::WorkspacePhase {
                workspace_path,
                phase,
            } => {
                if let Some(workspace) = self
                    .workspaces
                    .iter_mut()
                    .find(|workspace| workspace.path == workspace_path)
                {
                    workspace.phase = Some(phase.clone());
                    workspace.state = match phase {
                        ConvergeWorkspacePhase::Completed => WorkspaceRunState::Succeeded,
                        _ => WorkspaceRunState::Running,
                    };
                }

                self.active_workspace = Some(workspace_path.clone());
                if self.follow_running_workspace {
                    self.select_workspace_by_path(&workspace_path);
                }

                self.summary = match phase {
                    ConvergeWorkspacePhase::Completed => {
                        format!("Workspace ready: {workspace_path}")
                    }
                    _ => format!("Running {} for {workspace_path}", phase_label(&phase)),
                };
                self.detail = match phase {
                    ConvergeWorkspacePhase::PreparingAuth => {
                        "Preparing auth, variables, and local execution state.".to_string()
                    }
                    ConvergeWorkspacePhase::InitializingTofu => {
                        "Running `tofu init` for this workspace.".to_string()
                    }
                    ConvergeWorkspacePhase::ApplyingTofu => {
                        "Running `tofu apply` locally.".to_string()
                    }
                    ConvergeWorkspacePhase::RecordingState => {
                        "Syncing the workspace into Yaffle-managed local state.".to_string()
                    }
                    ConvergeWorkspacePhase::CollectingOutputs => {
                        "Loading outputs so downstream workspaces can use them.".to_string()
                    }
                    ConvergeWorkspacePhase::PublishingOutputs => {
                        "Publishing hosted outputs for local-first module resolution.".to_string()
                    }
                    ConvergeWorkspacePhase::Completed => {
                        "Workspace converge finished successfully.".to_string()
                    }
                };
            }
            EngineProgressEvent::TofuLog {
                workspace_path,
                stream,
                line,
            } => {
                self.active_workspace = Some(workspace_path.clone());
                if self.follow_running_workspace {
                    self.select_workspace_by_path(&workspace_path);
                }
                let logs = self.workspace_logs.entry(workspace_path).or_default();
                logs.push(WorkspaceLogLine { stream, text: line });
                if logs.len() > 200 {
                    let drain_count = logs.len() - 200;
                    logs.drain(0..drain_count);
                }
            }
            EngineProgressEvent::WorkspaceOutputs {
                workspace_path,
                outputs,
            } => {
                self.workspace_outputs.insert(workspace_path, outputs);
            }
        }
    }

    fn apply_remote_handle(&mut self, handle: &CloudRemoteConvergeHandle) {
        self.environment_name = handle.environment_name.clone();
        self.workspaces = handle
            .workspace_paths
            .iter()
            .map(|path| WorkspaceConvergeView {
                path: path.clone(),
                state: WorkspaceRunState::Pending,
                phase: Some(ConvergeWorkspacePhase::PreparingAuth),
            })
            .collect();
        self.summary = "Remote converge queued".to_string();
        self.detail = format!(
            "Yaffle Cloud queued run group {} for remote execution.",
            handle.run_group_id
        );
    }

    fn apply_remote_status(&mut self, status: &CloudRemoteConvergeStatus) {
        if self.workspaces.is_empty() {
            self.workspaces = status
                .deployments
                .iter()
                .map(|deployment| WorkspaceConvergeView {
                    path: deployment.workspace_path.clone(),
                    state: remote_workspace_state(deployment.status.as_str()),
                    phase: remote_workspace_phase(deployment),
                })
                .collect();
        }

        for deployment in &status.deployments {
            if let Some(workspace) = self
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.path == deployment.workspace_path)
            {
                workspace.state = remote_workspace_state(deployment.status.as_str());
                workspace.phase = remote_workspace_phase(deployment);
            }
        }

        self.active_workspace = status
            .deployments
            .iter()
            .find(|deployment| {
                remote_workspace_state(deployment.status.as_str()) == WorkspaceRunState::Running
            })
            .or_else(|| status.deployments.last())
            .map(|deployment| deployment.workspace_path.clone());
        if self.follow_running_workspace {
            let active_path = self.active_workspace.clone();
            if let Some(active_path) = active_path.as_deref() {
                self.select_workspace_by_path(active_path);
            }
        }

        self.summary = format!("Remote converge {}", status.run_group.status);
        self.detail = format!(
            "Yaffle Cloud run group {} is {}.",
            status.run_group.id, status.run_group.status
        );
    }

    fn mark_finished_success(&mut self, summary: &str) {
        self.summary = "Converge complete".to_string();
        self.detail = summary.to_string();
    }

    fn mark_finished_failure(&mut self, message: &str) {
        self.summary = "Converge failed".to_string();
        self.detail = "Yaffle stopped before the environment finished converging.".to_string();
        self.failure_message = Some(message.to_string());

        for workspace in self
            .workspaces
            .iter_mut()
            .filter(|workspace| workspace.state == WorkspaceRunState::Running)
        {
            workspace.state = WorkspaceRunState::Failed;
        }
    }

    fn tick(&mut self) {
        self.spinner_index = (self.spinner_index + 1) % 10;
        if self.follow_running_workspace {
            let active_path = self.active_workspace.clone();
            if let Some(active_path) = active_path.as_deref() {
                self.select_workspace_by_path(active_path);
            }
        }
    }

    fn select_workspace_by_path(&mut self, workspace_path: &str) {
        if let Some(index) = self
            .workspaces
            .iter()
            .position(|workspace| workspace.path == workspace_path)
        {
            self.selected_workspace_index = index;
        }
    }
}

fn render_workspace_log_line(log: &WorkspaceLogLine) -> Line {
    let label = match log.stream {
        TofuLogStream::Stdout => "stdout",
        TofuLogStream::Stderr => "stderr",
    };
    let color = match log.stream {
        TofuLogStream::Stdout => YAFFLE_GREEN_SOFT,
        TofuLogStream::Stderr => YAFFLE_RED,
    };

    Line::from(vec![
        Span::styled(format!("[{label}]"), Style::default().fg(color)),
        Span::raw(" "),
        Span::raw(log.text.clone()),
    ])
}

fn phase_label(phase: &ConvergeWorkspacePhase) -> &'static str {
    match phase {
        ConvergeWorkspacePhase::PreparingAuth => "preparing auth",
        ConvergeWorkspacePhase::InitializingTofu => "tofu init",
        ConvergeWorkspacePhase::ApplyingTofu => "tofu apply",
        ConvergeWorkspacePhase::RecordingState => "recording local state",
        ConvergeWorkspacePhase::CollectingOutputs => "loading outputs",
        ConvergeWorkspacePhase::PublishingOutputs => "publishing hosted outputs",
        ConvergeWorkspacePhase::Completed => "done",
    }
}

fn remote_workspace_state(status: &str) -> WorkspaceRunState {
    match status {
        "success" | "skipped" => WorkspaceRunState::Succeeded,
        "failed" => WorkspaceRunState::Failed,
        "planning" | "applying" | "destroying" | "running" => WorkspaceRunState::Running,
        _ => WorkspaceRunState::Pending,
    }
}

fn remote_workspace_phase(
    deployment: &yaffle_engine::CloudRemoteDeploymentStatus,
) -> Option<ConvergeWorkspacePhase> {
    if remote_workspace_state(deployment.status.as_str()) == WorkspaceRunState::Succeeded {
        return Some(ConvergeWorkspacePhase::Completed);
    }

    let Some(run) = deployment.latest_run.as_ref() else {
        return Some(ConvergeWorkspacePhase::PreparingAuth);
    };

    if run.status == "success" || run.status == "skipped" {
        return Some(ConvergeWorkspacePhase::Completed);
    }

    match run.run_type.as_str() {
        "apply" => Some(ConvergeWorkspacePhase::ApplyingTofu),
        "plan" => Some(ConvergeWorkspacePhase::InitializingTofu),
        _ => Some(ConvergeWorkspacePhase::PreparingAuth),
    }
}

#[derive(Debug)]
enum ShellAction {
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TuiKey {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    Enter,
    Esc,
    Tab,
    Space,
}

#[derive(Debug)]
struct ActiveConvergeRun {
    execution_location: TuiExecutionLocation,
    progress: ConvergeTuiState,
    rx: mpsc::Receiver<ConvergeTuiEvent>,
    running: bool,
    last_response: Option<EngineResponse>,
    last_error: Option<EngineError>,
    last_remote_status: Option<CloudRemoteConvergeStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TuiCapabilityMode {
    AnonymousLocal,
    AccountLocal,
    AccountRemote,
}

impl TuiCapabilityMode {
    fn as_snapshot_value(self) -> &'static str {
        match self {
            Self::AnonymousLocal => "anonymousLocal",
            Self::AccountLocal => "accountLocal",
            Self::AccountRemote => "accountRemote",
        }
    }

    fn execution_location(self) -> TuiExecutionLocation {
        match self {
            Self::AnonymousLocal | Self::AccountLocal => TuiExecutionLocation::Local,
            Self::AccountRemote => TuiExecutionLocation::Remote,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TuiExecutionLocation {
    Local,
    Remote,
}

impl TuiExecutionLocation {
    fn as_snapshot_value(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Local => "local execution",
            Self::Remote => "remote execution",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TuiCapability {
    mode: TuiCapabilityMode,
    label: String,
    detail: String,
    repo_full_name: Option<String>,
    action_label: Option<String>,
    action_url: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalEnvironmentEntry {
    name: String,
    kind: String,
    workspace_count: usize,
    status_vector: Vec<EnvironmentStatusCount>,
    local_state_detected: bool,
    repo: Option<String>,
    origin: Option<String>,
    status: Option<String>,
    head_sha: Option<String>,
    updated_at: Option<String>,
    actor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentStatusCount {
    status: String,
    count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellView {
    EnvironmentList,
    EnvironmentDetail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellFocus {
    Graph,
    Detail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetailTab {
    Overview,
    Plan,
    Apply,
    Outputs,
    Activation,
    Verification,
    Runs,
}

#[derive(Debug)]
struct LocalEnvironmentDetailState {
    environment_name: String,
    graph: ResolvedWorkspaceGraph,
    dag_nodes: Vec<EnvironmentDagNode>,
    levels: Vec<Vec<String>>,
    selected_level: usize,
    selected_row: usize,
    selected_workspaces: std::collections::BTreeSet<String>,
    focus: ShellFocus,
    tab: DetailTab,
    detail_spotlight: bool,
    detail_scroll: usize,
    status_response: Option<EngineResponse>,
    status_error: Option<String>,
    status_loading: bool,
    status_rx: Option<mpsc::Receiver<Result<EngineResponse, EngineError>>>,
    outputs_response: Option<EngineResponse>,
    outputs_error: Option<String>,
    outputs_loading: bool,
    outputs_rx: Option<mpsc::Receiver<Result<EngineResponse, EngineError>>>,
    active_run: Option<ActiveConvergeRun>,
    follow_running_workspace: bool,
}

struct DetailPanelContent {
    header_lines: Vec<Line>,
    body_lines: Vec<Line>,
}

#[derive(Debug, Clone)]
struct EnvironmentDagNode {
    id: String,
    workspace_path: String,
    label: String,
    dependencies: Vec<String>,
    kind: EnvironmentDagNodeKind,
}

#[derive(Debug, Clone)]
enum EnvironmentDagNodeKind {
    Workspace,
}

#[derive(Debug)]
struct LocalAppState {
    repo_root: PathBuf,
    config: yaffle_config::YaffleConfig,
    capability: TuiCapability,
    environments: Vec<LocalEnvironmentEntry>,
    selected_env_index: usize,
    view: ShellView,
    detail: Option<LocalEnvironmentDetailState>,
    footer_message: String,
}

impl LocalAppState {
    fn load(working_dir: &Path) -> Result<Self, CliFailure> {
        let (repo_root, config) = load_local_config_context(working_dir)?;
        let capability = resolve_tui_capability(&repo_root);
        let environments = discover_tui_environments(&repo_root, &config, &capability);

        Ok(Self {
            repo_root,
            config,
            capability,
            environments,
            selected_env_index: 0,
            view: ShellView::EnvironmentList,
            detail: None,
            footer_message: "Environment browser".to_string(),
        })
    }

    fn tick(&mut self) {
        if let Some(detail) = self.detail.as_mut() {
            detail.tick(&self.repo_root);
        }
    }

    fn open_environment_for_request(&mut self, request: &EngineRequest) -> Result<(), CliFailure> {
        let environment_name = request
            .target
            .as_ref()
            .map(|target| target.environment.as_str())
            .ok_or_else(|| {
                command_error(
                    false,
                    Some(EngineOperation::Converge),
                    None,
                    Some(request.selection.clone()),
                    "environment_required",
                    "A converge target environment is required.",
                )
            })?;

        let mut detail = load_environment_detail(&self.repo_root, &self.config, environment_name)?;
        for workspace in &request.selection.workspaces {
            detail.selected_workspaces.insert(workspace.clone());
        }
        self.detail = Some(detail);
        self.view = ShellView::EnvironmentDetail;
        self.footer_message = "Environment detail".to_string();
        Ok(())
    }

    fn start_converge_in_place(&mut self, request: EngineRequest) -> Result<(), CliFailure> {
        if self.capability.mode == TuiCapabilityMode::AccountRemote {
            return self.start_remote_converge_in_place(request);
        }

        self.start_local_converge_in_place(request)
    }

    fn start_local_converge_in_place(&mut self, request: EngineRequest) -> Result<(), CliFailure> {
        let Some(detail) = self.detail.as_mut() else {
            return Err(command_error(
                false,
                Some(EngineOperation::Converge),
                request.target.clone(),
                Some(request.selection.clone()),
                "environment_view_missing",
                "Cannot start converge without an open environment view.",
            ));
        };

        if detail
            .active_run
            .as_ref()
            .map(|run| run.running)
            .unwrap_or(false)
        {
            return Ok(());
        }

        detail.focus = ShellFocus::Graph;
        detail.tab = DetailTab::Apply;
        detail.follow_running_workspace = true;

        let working_dir = self.repo_root.clone();
        let (tx, rx) = mpsc::channel::<ConvergeTuiEvent>();
        let request_for_worker = request.clone();
        thread::spawn(move || {
            let mut sender = |event| {
                let _ = tx.send(ConvergeTuiEvent::Progress(event));
            };
            let result = execute_with_progress(&request_for_worker, &working_dir, &mut sender);
            let _ = tx.send(ConvergeTuiEvent::Finished(result));
        });

        let mut progress = ConvergeTuiState::new(detail.environment_name.clone());
        if !request.selection.workspaces.is_empty() {
            progress.detail = format!(
                "Converging a selected subset: {}",
                request.selection.workspaces.join(", ")
            );
        }
        detail.active_run = Some(ActiveConvergeRun {
            execution_location: TuiExecutionLocation::Local,
            progress,
            rx,
            running: true,
            last_response: None,
            last_error: None,
            last_remote_status: None,
        });
        detail.status_response = None;
        detail.status_error = None;
        detail.status_loading = false;
        detail.status_rx = None;
        detail.outputs_response = None;
        detail.outputs_error = None;
        detail.outputs_loading = false;
        detail.outputs_rx = None;
        Ok(())
    }

    fn start_remote_converge_in_place(&mut self, request: EngineRequest) -> Result<(), CliFailure> {
        let Some(detail) = self.detail.as_mut() else {
            return Err(command_error(
                false,
                Some(EngineOperation::Converge),
                request.target.clone(),
                Some(request.selection.clone()),
                "environment_view_missing",
                "Cannot start converge without an open environment view.",
            ));
        };

        if detail
            .active_run
            .as_ref()
            .map(|run| run.running)
            .unwrap_or(false)
        {
            return Ok(());
        }

        detail.focus = ShellFocus::Graph;
        detail.tab = DetailTab::Apply;
        detail.follow_running_workspace = true;

        let working_dir = self.repo_root.clone();
        let (tx, rx) = mpsc::channel::<ConvergeTuiEvent>();
        let request_for_worker = request.clone();
        thread::spawn(move || {
            let result = run_remote_converge_for_tui(working_dir, request_for_worker, tx.clone());
            let _ = tx.send(ConvergeTuiEvent::RemoteFinished(result));
        });

        let mut progress = ConvergeTuiState::new(detail.environment_name.clone());
        progress.detail =
            "Yaffle Cloud is preparing remote execution for this converge.".to_string();
        if !request.selection.workspaces.is_empty() {
            progress.detail = format!(
                "Converging a selected subset remotely: {}",
                request.selection.workspaces.join(", ")
            );
        }
        detail.active_run = Some(ActiveConvergeRun {
            execution_location: TuiExecutionLocation::Remote,
            progress,
            rx,
            running: true,
            last_response: None,
            last_error: None,
            last_remote_status: None,
        });
        detail.status_response = None;
        detail.status_error = None;
        detail.status_loading = false;
        detail.status_rx = None;
        detail.outputs_response = None;
        detail.outputs_error = None;
        detail.outputs_loading = false;
        detail.outputs_rx = None;
        Ok(())
    }

    fn handle_key(&mut self, key: TuiKey) -> Result<Option<ShellAction>, CliFailure> {
        match self.view {
            ShellView::EnvironmentList => self.handle_environment_list_key(key),
            ShellView::EnvironmentDetail => self.handle_environment_detail_key(key),
        }
    }

    fn handle_graph_event(&mut self, event: OpenTuiGraphEvent) {
        if self.view != ShellView::EnvironmentDetail {
            return;
        }
        let Some(detail) = self.detail.as_mut() else {
            return;
        };
        let Some(workspace_path) = detail
            .dag_nodes
            .iter()
            .find(|node| node.id == event.node_id)
            .map(|node| node.workspace_path.clone())
        else {
            return;
        };

        detail.focus = ShellFocus::Graph;
        detail.select_workspace_by_path(&workspace_path);

        if matches!(event.action, OpenTuiGraphAction::Toggle) && !detail.active_run_is_running() {
            detail.toggle_workspace_target(&workspace_path);
        }
    }

    fn handle_environment_list_key(
        &mut self,
        key: TuiKey,
    ) -> Result<Option<ShellAction>, CliFailure> {
        match key {
            TuiKey::Char('q') => return Ok(Some(ShellAction::Quit)),
            TuiKey::Down | TuiKey::Char('j') => {
                if !self.environments.is_empty() {
                    self.selected_env_index =
                        (self.selected_env_index + 1) % self.environments.len();
                }
            }
            TuiKey::Up | TuiKey::Char('k') => {
                if !self.environments.is_empty() {
                    self.selected_env_index = if self.selected_env_index == 0 {
                        self.environments.len() - 1
                    } else {
                        self.selected_env_index - 1
                    };
                }
            }
            TuiKey::Enter => {
                if let Some(entry) = self.environments.get(self.selected_env_index) {
                    let detail =
                        load_environment_detail(&self.repo_root, &self.config, &entry.name)?;
                    self.detail = Some(detail);
                    self.view = ShellView::EnvironmentDetail;
                    self.footer_message = "Environment detail".to_string();
                }
            }
            _ => {}
        }

        Ok(None)
    }

    fn handle_environment_detail_key(
        &mut self,
        key: TuiKey,
    ) -> Result<Option<ShellAction>, CliFailure> {
        let Some(detail) = self.detail.as_mut() else {
            self.view = ShellView::EnvironmentList;
            return Ok(None);
        };

        match key {
            TuiKey::Char('q') => return Ok(Some(ShellAction::Quit)),
            TuiKey::Esc if detail.detail_spotlight => {
                detail.detail_spotlight = false;
            }
            TuiKey::Char('b') | TuiKey::Esc => {
                if detail
                    .active_run
                    .as_ref()
                    .map(|run| run.running)
                    .unwrap_or(false)
                {
                    return Ok(None);
                }
                self.view = ShellView::EnvironmentList;
                self.detail = None;
                self.footer_message = "Environment browser".to_string();
            }
            TuiKey::Tab => {
                detail.focus = match detail.focus {
                    ShellFocus::Graph => ShellFocus::Detail,
                    ShellFocus::Detail => ShellFocus::Graph,
                };
            }
            TuiKey::Char('z') => {
                detail.detail_spotlight = !detail.detail_spotlight;
                if detail.detail_spotlight {
                    detail.focus = ShellFocus::Detail;
                }
            }
            TuiKey::Char('f') => {
                detail.follow_running_workspace = true;
            }
            TuiKey::Char('c') => {
                let request = detail.to_engine_request();
                self.start_converge_in_place(request)?;
            }
            _ => match detail.focus {
                ShellFocus::Graph => detail.handle_graph_key(key),
                ShellFocus::Detail => detail.handle_detail_key(key, &self.repo_root)?,
            },
        }

        Ok(None)
    }
}

impl LocalEnvironmentDetailState {
    fn tick(&mut self, repo_root: &Path) {
        let mut finished_success = false;
        let mut finished_failure = false;
        let mut follow_target: Option<String> = None;
        if let Some(run) = self.active_run.as_mut() {
            run.progress.tick();
            while let Ok(event) = run.rx.try_recv() {
                match event {
                    ConvergeTuiEvent::Progress(progress) => {
                        run.progress.apply_progress(progress);
                        if self.follow_running_workspace {
                            follow_target = run.progress.active_workspace.clone();
                        }
                    }
                    ConvergeTuiEvent::Finished(result) => match result {
                        Ok(response) => {
                            run.running = false;
                            run.progress.mark_finished_success(&response.result.summary);
                            run.last_response = Some(response);
                            finished_success = true;
                        }
                        Err(error) => {
                            run.running = false;
                            run.progress.mark_finished_failure(&error.error.message);
                            run.last_error = Some(error);
                            finished_failure = true;
                        }
                    },
                    ConvergeTuiEvent::RemoteQueued(handle) => {
                        run.progress.apply_remote_handle(&handle);
                    }
                    ConvergeTuiEvent::RemoteStatus(status) => {
                        run.progress.apply_remote_status(&status);
                        if self.follow_running_workspace {
                            follow_target = run.progress.active_workspace.clone();
                        }
                        run.last_remote_status = Some(status);
                    }
                    ConvergeTuiEvent::RemoteFinished(result) => match result {
                        Ok(status) => {
                            run.running = false;
                            run.progress.apply_remote_status(&status);
                            if remote_status_failed(&status) {
                                run.progress
                                    .mark_finished_failure(&remote_failure_message(&status));
                                finished_failure = true;
                            } else {
                                run.progress.mark_finished_success(
                                    "Remote execution finished successfully in Yaffle Cloud.",
                                );
                                finished_success = true;
                            }
                            run.last_remote_status = Some(status);
                        }
                        Err(message) => {
                            run.running = false;
                            run.progress.mark_finished_failure(&message);
                            finished_failure = true;
                        }
                    },
                }
            }
        }

        if let Some(active) = follow_target.as_deref() {
            self.select_workspace_by_path(active);
        }

        if finished_success {
            self.status_response = None;
            self.status_error = None;
            self.status_loading = false;
            self.status_rx = None;
            self.outputs_response = None;
            self.outputs_error = None;
            self.outputs_loading = false;
            self.outputs_rx = None;
            self.follow_running_workspace = false;
        }
        if finished_failure {
            self.follow_running_workspace = false;
        }

        self.poll_status_load();
        self.poll_outputs_load();

        let run_finished = !self
            .active_run
            .as_ref()
            .map(|run| run.running)
            .unwrap_or(false);
        let should_load_local_detail = self
            .active_run
            .as_ref()
            .map(|run| run.execution_location == TuiExecutionLocation::Local)
            .unwrap_or(true);
        if run_finished && should_load_local_detail {
            match self.tab {
                DetailTab::Apply => self.load_selected_tab_if_needed(repo_root),
                DetailTab::Outputs => self.load_selected_tab_if_needed(repo_root),
                DetailTab::Activation | DetailTab::Verification => {
                    self.load_selected_tab_if_needed(repo_root)
                }
                DetailTab::Runs | DetailTab::Plan => {}
                DetailTab::Overview => self.load_selected_tab_if_needed(repo_root),
            }
        }
    }

    fn selected_node_id(&self) -> Option<&str> {
        self.levels
            .get(self.selected_level)
            .and_then(|level| level.get(self.selected_row))
            .map(|value| value.as_str())
    }

    fn selected_node(&self) -> Option<&EnvironmentDagNode> {
        let selected = self.selected_node_id()?;
        self.dag_nodes.iter().find(|node| node.id == selected)
    }

    fn selected_workspace_path(&self) -> Option<&str> {
        self.selected_node()
            .map(|node| node.workspace_path.as_str())
    }

    fn active_run_is_running(&self) -> bool {
        self.active_run
            .as_ref()
            .map(|run| run.running)
            .unwrap_or(false)
    }

    fn toggle_workspace_target(&mut self, workspace_path: &str) {
        if !self.selected_workspaces.insert(workspace_path.to_string()) {
            self.selected_workspaces.remove(workspace_path);
        }
    }

    fn select_workspace_by_path(&mut self, workspace_path: &str) {
        if let Some((level_index, row_index)) =
            self.levels
                .iter()
                .enumerate()
                .find_map(|(level_index, level)| {
                    level
                        .iter()
                        .position(|node_id| node_id == workspace_path)
                        .map(|row_index| (level_index, row_index))
                })
        {
            self.selected_level = level_index;
            self.selected_row = row_index;
        }
    }

    fn handle_graph_key(&mut self, key: TuiKey) {
        let previous_level = self.selected_level;
        let previous_row = self.selected_row;
        match key {
            TuiKey::Left | TuiKey::Char('h') => {
                if self.selected_level > 0 {
                    self.selected_level -= 1;
                    self.selected_row = self
                        .selected_row
                        .min(self.levels[self.selected_level].len().saturating_sub(1));
                }
            }
            TuiKey::Right | TuiKey::Char('l') => {
                if self.selected_level + 1 < self.levels.len() {
                    self.selected_level += 1;
                    self.selected_row = self
                        .selected_row
                        .min(self.levels[self.selected_level].len().saturating_sub(1));
                }
            }
            TuiKey::Down | TuiKey::Char('j') => {
                if let Some(level) = self.levels.get(self.selected_level) {
                    if !level.is_empty() {
                        self.selected_row = (self.selected_row + 1) % level.len();
                    }
                }
            }
            TuiKey::Up | TuiKey::Char('k') => {
                if let Some(level) = self.levels.get(self.selected_level) {
                    if !level.is_empty() {
                        self.selected_row = if self.selected_row == 0 {
                            level.len() - 1
                        } else {
                            self.selected_row - 1
                        };
                    }
                }
            }
            TuiKey::Space => {
                if self.active_run_is_running() {
                    return;
                }
                if let Some(workspace) = self.selected_workspace_path().map(ToOwned::to_owned) {
                    self.toggle_workspace_target(&workspace);
                }
            }
            _ => {}
        }

        if previous_level != self.selected_level || previous_row != self.selected_row {
            self.detail_scroll = 0;
        }
    }

    fn handle_detail_key(&mut self, key: TuiKey, repo_root: &Path) -> Result<(), CliFailure> {
        match key {
            TuiKey::Left | TuiKey::Char('h') => {
                self.tab = match self.tab {
                    DetailTab::Overview => DetailTab::Runs,
                    DetailTab::Plan => DetailTab::Overview,
                    DetailTab::Apply => DetailTab::Plan,
                    DetailTab::Outputs => DetailTab::Apply,
                    DetailTab::Activation => DetailTab::Outputs,
                    DetailTab::Verification => DetailTab::Activation,
                    DetailTab::Runs => DetailTab::Verification,
                };
                self.detail_scroll = 0;
                self.load_selected_tab_if_needed(repo_root);
            }
            TuiKey::Right | TuiKey::Char('l') => {
                self.tab = match self.tab {
                    DetailTab::Overview => DetailTab::Plan,
                    DetailTab::Plan => DetailTab::Apply,
                    DetailTab::Apply => DetailTab::Outputs,
                    DetailTab::Outputs => DetailTab::Activation,
                    DetailTab::Activation => DetailTab::Verification,
                    DetailTab::Verification => DetailTab::Runs,
                    DetailTab::Runs => DetailTab::Overview,
                };
                self.detail_scroll = 0;
                self.load_selected_tab_if_needed(repo_root);
            }
            TuiKey::Down | TuiKey::Char('j') => {
                self.detail_scroll = self.detail_scroll.saturating_add(1);
            }
            TuiKey::Up | TuiKey::Char('k') => {
                self.detail_scroll = self.detail_scroll.saturating_sub(1);
            }
            TuiKey::Char('r') => {
                self.reload_selected_tab(repo_root)?;
            }
            _ => {}
        }

        Ok(())
    }

    fn to_engine_request(&self) -> EngineRequest {
        EngineRequest {
            operation: EngineOperation::Converge,
            target: Some(EnvironmentTarget {
                environment: self.environment_name.clone(),
            }),
            selection: WorkspaceSelection {
                workspaces: self.selected_workspaces.iter().cloned().collect(),
            },
            wait_for: None,
        }
    }

    fn load_selected_tab_if_needed(&mut self, repo_root: &Path) {
        match self.tab {
            DetailTab::Apply => self.start_status_load_if_needed(repo_root),
            DetailTab::Outputs => self.start_outputs_load_if_needed(repo_root),
            DetailTab::Activation | DetailTab::Verification => {
                self.start_status_load_if_needed(repo_root)
            }
            DetailTab::Overview => self.start_status_load_if_needed(repo_root),
            DetailTab::Runs | DetailTab::Plan => {}
        };
    }

    fn running_summary(&self) -> Option<(&ConvergeTuiState, bool)> {
        self.active_run
            .as_ref()
            .map(|run| (&run.progress, run.running))
    }

    fn active_run_status_for_workspace(
        &self,
        workspace_path: &str,
    ) -> Option<(WorkspaceRunState, Option<&ConvergeWorkspacePhase>)> {
        self.active_run.as_ref().and_then(|run| {
            run.progress
                .workspaces
                .iter()
                .find(|workspace| workspace.path == workspace_path)
                .map(|workspace| (workspace.state, workspace.phase.as_ref()))
        })
    }

    fn selected_workspace_log_lines(&self) -> &[WorkspaceLogLine] {
        let Some(selected) = self.selected_workspace_path() else {
            return &[];
        };
        self.active_run
            .as_ref()
            .and_then(|run| run.progress.workspace_logs.get(selected))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn active_run_error(&self) -> Option<&EngineError> {
        self.active_run
            .as_ref()
            .and_then(|run| run.last_error.as_ref())
    }

    fn selected_workspace_lifecycle_block_reasons(&self) -> Vec<String> {
        let Some(selected) = self.selected_workspace_path() else {
            return Vec::new();
        };
        let Some(status) = self.status_response.as_ref() else {
            return Vec::new();
        };
        let Some(lifecycle) = status
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == selected)
            .and_then(|workspace| workspace.lifecycle.as_ref())
        else {
            return Vec::new();
        };

        lifecycle
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| item.get("state").and_then(Value::as_str) == Some("blocked"))
            .map(|item| {
                let key = item.get("key").and_then(Value::as_str).unwrap_or("unknown");
                let phase = item
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("lifecycle");
                let reason = item
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("blocked by lifecycle governance");
                format!("{} '{}' blocked: {}", title_case(phase), key, reason)
            })
            .collect()
    }

    fn selected_node_title(&self) -> String {
        match self.selected_node().map(|node| &node.kind) {
            Some(EnvironmentDagNodeKind::Workspace) => {
                self.selected_workspace_path().unwrap_or("none").to_string()
            }
            None => "none".to_string(),
        }
    }

    fn selected_workspace_lifecycle_items(&self, phase: &str) -> Vec<&Value> {
        let Some(selected) = self.selected_workspace_path() else {
            return Vec::new();
        };
        let Some(status) = self.status_response.as_ref() else {
            return Vec::new();
        };
        let Some(lifecycle) = status
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == selected)
            .and_then(|workspace| workspace.lifecycle.as_ref())
        else {
            return Vec::new();
        };

        lifecycle
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| item.get("phase").and_then(Value::as_str) == Some(phase))
            .collect()
    }

    fn reload_selected_tab(&mut self, repo_root: &Path) -> Result<(), CliFailure> {
        match self.tab {
            DetailTab::Apply => {
                self.status_response = None;
                self.status_error = None;
                self.status_loading = false;
                self.status_rx = None;
                self.start_status_load_if_needed(repo_root);
                Ok(())
            }
            DetailTab::Outputs => {
                self.outputs_response = None;
                self.outputs_error = None;
                self.outputs_loading = false;
                self.outputs_rx = None;
                self.start_outputs_load_if_needed(repo_root);
                Ok(())
            }
            DetailTab::Activation | DetailTab::Verification => {
                self.status_response = None;
                self.status_error = None;
                self.status_loading = false;
                self.status_rx = None;
                self.start_status_load_if_needed(repo_root);
                Ok(())
            }
            DetailTab::Overview => {
                self.status_response = None;
                self.status_error = None;
                self.status_loading = false;
                self.status_rx = None;
                self.start_status_load_if_needed(repo_root);
                Ok(())
            }
            DetailTab::Runs | DetailTab::Plan => Ok(()),
        }
    }

    fn start_status_load_if_needed(&mut self, repo_root: &Path) {
        if self.status_response.is_some() || self.status_error.is_some() || self.status_loading {
            return;
        }

        let environment_name = self.environment_name.clone();
        let repo_root = repo_root.to_path_buf();
        let (tx, rx) = mpsc::channel::<Result<EngineResponse, EngineError>>();
        self.status_loading = true;
        self.status_rx = Some(rx);

        thread::spawn(move || {
            let result = execute(
                &EngineRequest {
                    operation: EngineOperation::Status,
                    target: Some(EnvironmentTarget {
                        environment: environment_name,
                    }),
                    selection: WorkspaceSelection::default(),
                    wait_for: None,
                },
                &repo_root,
            );
            let _ = tx.send(result);
        });
    }

    fn poll_status_load(&mut self) {
        if !self.status_loading {
            return;
        }

        if let Some(rx) = self.status_rx.as_ref() {
            match rx.try_recv() {
                Ok(result) => {
                    self.status_loading = false;
                    self.status_rx = None;
                    match result {
                        Ok(response) => {
                            self.status_response = Some(response);
                            self.status_error = None;
                        }
                        Err(error) => {
                            self.status_response = None;
                            self.status_error = Some(error.error.message);
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.status_loading = false;
                    self.status_rx = None;
                    self.status_error =
                        Some("Status loading worker disconnected unexpectedly.".to_string());
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
    }

    fn start_outputs_load_if_needed(&mut self, repo_root: &Path) {
        if self.outputs_response.is_some() || self.outputs_error.is_some() || self.outputs_loading {
            return;
        }

        let environment_name = self.environment_name.clone();
        let repo_root = repo_root.to_path_buf();
        let (tx, rx) = mpsc::channel::<Result<EngineResponse, EngineError>>();
        self.outputs_loading = true;
        self.outputs_rx = Some(rx);

        thread::spawn(move || {
            let result = execute(
                &EngineRequest {
                    operation: EngineOperation::Outputs,
                    target: Some(EnvironmentTarget {
                        environment: environment_name,
                    }),
                    selection: WorkspaceSelection::default(),
                    wait_for: None,
                },
                &repo_root,
            );
            let _ = tx.send(result);
        });
    }

    fn poll_outputs_load(&mut self) {
        if !self.outputs_loading {
            return;
        }

        if let Some(rx) = self.outputs_rx.as_ref() {
            match rx.try_recv() {
                Ok(result) => {
                    self.outputs_loading = false;
                    self.outputs_rx = None;
                    match result {
                        Ok(response) => {
                            self.outputs_response = Some(response);
                            self.outputs_error = None;
                        }
                        Err(error) => {
                            self.outputs_response = None;
                            self.outputs_error = Some(error.error.message);
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.outputs_loading = false;
                    self.outputs_rx = None;
                    self.outputs_error =
                        Some("Outputs loading worker disconnected unexpectedly.".to_string());
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSnapshot {
    view: &'static str,
    cloud: CloudStatusSnapshot,
    capability: TuiCapabilitySnapshot,
    browser: EnvironmentBrowserSnapshot,
    detail: Option<EnvironmentDetailSnapshot>,
    footer_message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TuiCapabilitySnapshot {
    mode: &'static str,
    execution_location: &'static str,
    label: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo_full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudStatusSnapshot {
    kind: &'static str,
    label: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentBrowserSnapshot {
    environments: Vec<EnvironmentListItemSnapshot>,
    footer: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentListItemSnapshot {
    name: String,
    kind: String,
    workspace_count: usize,
    status_vector: Vec<EnvironmentStatusCount>,
    local_state_detected: bool,
    selected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentDetailSnapshot {
    environment_name: String,
    selected_node: String,
    detail_spotlight: bool,
    graph: EnvironmentGraphSnapshot,
    selected_workspace: Option<SelectedWorkspaceSnapshot>,
    target_summary: String,
    mode_line: String,
    governance_line: String,
    focus: &'static str,
    running: bool,
    tabs: Vec<DetailTabSnapshot>,
    detail_header_lines: Vec<Line>,
    detail_body_lines: Vec<Line>,
    detail_scroll: usize,
    footer: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentGraphSnapshot {
    selected_node_id: String,
    levels: Vec<Vec<String>>,
    nodes: Vec<EnvironmentGraphNodeSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentGraphNodeSnapshot {
    id: String,
    workspace_path: String,
    label: String,
    dependencies: Vec<String>,
    selected: bool,
    targeted: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    activation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedWorkspaceSnapshot {
    path: String,
    run_state: String,
    current_phase: String,
    materialization: String,
    freshness: String,
    readiness: String,
    acceptability: String,
    activation: String,
    verification: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailTabSnapshot {
    id: &'static str,
    label: &'static str,
    selected: bool,
}

fn render_shell_snapshot(app: &LocalAppState) -> ShellSnapshot {
    ShellSnapshot {
        view: match app.view {
            ShellView::EnvironmentList => "environmentList",
            ShellView::EnvironmentDetail => "environmentDetail",
        },
        cloud: render_cloud_status_snapshot(&app.capability),
        capability: render_tui_capability_snapshot(&app.capability),
        browser: render_environment_browser_snapshot(app),
        detail: app
            .detail
            .as_ref()
            .map(|detail| render_environment_detail_snapshot(detail, &app.capability)),
        footer_message: app.footer_message.clone(),
    }
}

fn render_tui_capability_snapshot(capability: &TuiCapability) -> TuiCapabilitySnapshot {
    TuiCapabilitySnapshot {
        mode: capability.mode.as_snapshot_value(),
        execution_location: capability.mode.execution_location().as_snapshot_value(),
        label: capability.label.clone(),
        detail: capability.detail.clone(),
        repo_full_name: capability.repo_full_name.clone(),
        action_label: capability.action_label.clone(),
        action_url: capability.action_url.clone(),
    }
}

fn render_cloud_status_snapshot(capability: &TuiCapability) -> CloudStatusSnapshot {
    let Ok(status) = load_local_cloud_auth_status() else {
        return CloudStatusSnapshot {
            kind: "unavailable",
            label: "Cloud status unavailable".to_string(),
            detail: "Could not read local Yaffle Cloud auth state.".to_string(),
            identity: None,
            expires_at: None,
            action_label: None,
            action_url: None,
        };
    };

    let Some(principal) = status.stored_principal else {
        return CloudStatusSnapshot {
            kind: "none",
            label: capability.label.clone(),
            detail: capability.detail.clone(),
            identity: None,
            expires_at: None,
            action_label: capability.action_label.clone(),
            action_url: capability.action_url.clone(),
        };
    };

    let expires_at = principal.expires_at.clone();
    let identity = match principal.principal_type {
        StoredPrincipalType::Account => Some(describe_identity(&principal)),
        StoredPrincipalType::AnonymousSession => None,
    };

    if status.expired {
        return CloudStatusSnapshot {
            kind: "expired",
            label: match principal.principal_type {
                StoredPrincipalType::Account => "Cloud account expired".to_string(),
                StoredPrincipalType::AnonymousSession => "Anonymous session expired".to_string(),
            },
            detail: "Run `yaffle cloud login` or `yaffle converge` to refresh credentials."
                .to_string(),
            identity,
            expires_at,
            action_label: None,
            action_url: None,
        };
    }

    match principal.principal_type {
        StoredPrincipalType::Account => CloudStatusSnapshot {
            kind: match capability.mode {
                TuiCapabilityMode::AccountRemote => "paid",
                _ => "free",
            },
            label: capability.label.clone(),
            detail: capability.detail.clone(),
            identity,
            expires_at,
            action_label: capability.action_label.clone(),
            action_url: capability.action_url.clone(),
        },
        StoredPrincipalType::AnonymousSession => CloudStatusSnapshot {
            kind: "none",
            label: capability.label.clone(),
            detail: capability.detail.clone(),
            identity: None,
            expires_at,
            action_label: capability.action_label.clone(),
            action_url: capability.action_url.clone(),
        },
    }
}

fn render_environment_browser_snapshot(app: &LocalAppState) -> EnvironmentBrowserSnapshot {
    EnvironmentBrowserSnapshot {
        environments: app
            .environments
            .iter()
            .enumerate()
            .map(|(index, environment)| EnvironmentListItemSnapshot {
                name: environment.name.clone(),
                kind: environment.kind.clone(),
                workspace_count: environment.workspace_count,
                status_vector: environment.status_vector.clone(),
                local_state_detected: environment.local_state_detected,
                selected: index == app.selected_env_index,
                repo: environment.repo.clone(),
                origin: environment.origin.clone(),
                status: environment.status.clone(),
                head_sha: environment.head_sha.clone(),
                updated_at: environment.updated_at.clone(),
                actor: environment.actor.clone(),
            })
            .collect(),
        footer: "Environment browser",
    }
}

fn render_environment_detail_snapshot(
    detail: &LocalEnvironmentDetailState,
    capability: &TuiCapability,
) -> EnvironmentDetailSnapshot {
    let selected = detail.selected_node_title();
    let running_summary = detail.running_summary();
    let running = running_summary.map(|(_, running)| running).unwrap_or(false);
    let governance_warning = detail.active_run_error().and_then(|error| {
        (error.error.code == "environment_governance_blocked")
            .then_some(error.error.message.as_str())
    });
    let detail_content = render_environment_detail_panel(detail);

    EnvironmentDetailSnapshot {
        environment_name: detail.environment_name.clone(),
        selected_node: selected,
        detail_spotlight: detail.detail_spotlight,
        graph: render_environment_graph_snapshot(detail),
        selected_workspace: render_selected_workspace_snapshot(detail),
        target_summary: summarize_selected_workspaces(detail),
        mode_line: render_detail_mode_line(detail, capability, running_summary),
        governance_line: governance_warning
            .map(|reason| format!("Governance: blocked • {reason}"))
            .unwrap_or_else(|| "Governance: no environment admission block".to_string()),
        focus: match detail.focus {
            ShellFocus::Graph => "graph",
            ShellFocus::Detail => "detail",
        },
        running,
        tabs: render_detail_tabs(detail.tab),
        detail_header_lines: detail_content.header_lines,
        detail_body_lines: detail_content.body_lines,
        detail_scroll: detail.detail_scroll,
        footer: environment_detail_footer(detail),
    }
}

fn render_detail_mode_line(
    detail: &LocalEnvironmentDetailState,
    capability: &TuiCapability,
    running_summary: Option<(&ConvergeTuiState, bool)>,
) -> String {
    let execution_location = detail
        .active_run
        .as_ref()
        .map(|run| run.execution_location)
        .unwrap_or_else(|| capability.mode.execution_location());
    match running_summary {
        Some((progress, true)) => format!(
            "{} • running • {} • focus follows active workspace: {}",
            execution_location.label(),
            progress.summary,
            if detail.follow_running_workspace {
                "on"
            } else {
                "off"
            }
        ),
        Some((progress, false)) => format!(
            "{} • review • last run: {}",
            execution_location.label(),
            progress.summary
        ),
        None => format!("{} • review", execution_location.label()),
    }
}

fn render_environment_graph_snapshot(
    detail: &LocalEnvironmentDetailState,
) -> EnvironmentGraphSnapshot {
    let selected_node_id = detail.selected_node_id().unwrap_or_default().to_string();
    EnvironmentGraphSnapshot {
        selected_node_id: selected_node_id.clone(),
        levels: detail.levels.clone(),
        nodes: detail
            .dag_nodes
            .iter()
            .map(|node| EnvironmentGraphNodeSnapshot {
                id: node.id.clone(),
                workspace_path: node.workspace_path.clone(),
                label: node.label.clone(),
                dependencies: node.dependencies.clone(),
                selected: node.id == selected_node_id,
                targeted: detail.selected_workspaces.contains(&node.workspace_path),
                status: environment_graph_node_status(detail, node),
                activation: workspace_lifecycle_phase_state(
                    detail,
                    &node.workspace_path,
                    "activation",
                ),
                verification: workspace_lifecycle_phase_state(
                    detail,
                    &node.workspace_path,
                    "verification",
                ),
            })
            .collect(),
    }
}

fn environment_graph_node_status(
    detail: &LocalEnvironmentDetailState,
    node: &EnvironmentDagNode,
) -> &'static str {
    match &node.kind {
        EnvironmentDagNodeKind::Workspace => {
            if let Some((run_state, _phase)) =
                detail.active_run_status_for_workspace(&node.workspace_path)
            {
                return match run_state {
                    WorkspaceRunState::Running => "running",
                    WorkspaceRunState::Succeeded => "converged",
                    WorkspaceRunState::Failed => "failed",
                    WorkspaceRunState::Pending => "waiting",
                };
            }

            let snapshot = detail.status_response.as_ref().and_then(|response| {
                response
                    .workspaces
                    .iter()
                    .find(|item| item.workspace_path == node.workspace_path)
            });
            match snapshot.and_then(|item| item.materialization.as_deref()) {
                Some("present") => "present",
                Some("partially_present") => "partial",
                Some("absent") => "absent",
                _ => "unknown",
            }
        }
    }
}

fn render_selected_workspace_snapshot(
    detail: &LocalEnvironmentDetailState,
) -> Option<SelectedWorkspaceSnapshot> {
    let workspace_path = detail.selected_workspace_path()?.to_string();
    let active = detail.active_run_status_for_workspace(&workspace_path);
    let snapshot = detail.status_response.as_ref().and_then(|response| {
        response
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_path == workspace_path)
    });

    Some(SelectedWorkspaceSnapshot {
        path: workspace_path.clone(),
        run_state: active
            .map(|(state, _)| workspace_run_state_label(state).to_string())
            .unwrap_or_else(|| "not running".to_string()),
        current_phase: active
            .and_then(|(_, phase)| phase.map(phase_label))
            .unwrap_or("not started")
            .to_string(),
        materialization: snapshot
            .and_then(|workspace| workspace.materialization.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        freshness: snapshot
            .and_then(|workspace| workspace.freshness.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        readiness: workspace_scope_condition_summary(detail, &workspace_path, "usable", true),
        acceptability: workspace_scope_condition_summary(
            detail,
            &workspace_path,
            "acceptable",
            false,
        ),
        activation: workspace_lifecycle_phase_summary(detail, &workspace_path, "activation"),
        verification: workspace_lifecycle_phase_summary(detail, &workspace_path, "verification"),
    })
}

fn workspace_run_state_label(state: WorkspaceRunState) -> &'static str {
    match state {
        WorkspaceRunState::Pending => "waiting",
        WorkspaceRunState::Running => "running",
        WorkspaceRunState::Succeeded => "converged",
        WorkspaceRunState::Failed => "failed",
    }
}

fn render_detail_tabs(selected: DetailTab) -> Vec<DetailTabSnapshot> {
    [
        (DetailTab::Overview, "overview", "Overview"),
        (DetailTab::Plan, "plan", "Plan"),
        (DetailTab::Apply, "apply", "Apply"),
        (DetailTab::Outputs, "outputs", "Outputs"),
        (DetailTab::Activation, "activation", "Activation"),
        (DetailTab::Verification, "verification", "Verification"),
        (DetailTab::Runs, "runs", "Runs"),
    ]
    .into_iter()
    .map(|(tab, id, label)| DetailTabSnapshot {
        id,
        label,
        selected: tab == selected,
    })
    .collect()
}

fn environment_detail_footer(detail: &LocalEnvironmentDetailState) -> &'static str {
    if detail.detail_spotlight {
        return "Detail spotlight";
    }

    match detail.focus {
        ShellFocus::Graph => {
            if detail
                .active_run
                .as_ref()
                .map(|run| run.running)
                .unwrap_or(false)
            {
                "Graph focus • selection locked while running"
            } else {
                "Graph focus • workspace targets selectable"
            }
        }
        ShellFocus::Detail => {
            if detail
                .active_run
                .as_ref()
                .map(|run| run.running)
                .unwrap_or(false)
            {
                "Detail focus • run in progress"
            } else {
                "Detail focus • workspace data available"
            }
        }
    }
}

fn render_environment_detail_panel(detail: &LocalEnvironmentDetailState) -> DetailPanelContent {
    let selected = detail.selected_node_title();
    match detail.tab {
        DetailTab::Overview => {
            let header_lines = vec![
                Line::from(format!("Selected workspace: {selected}")),
                Line::from("Materialization, freshness, readiness, acceptability"),
                Line::from(""),
            ];
            let mut body_lines = Vec::new();
            match (&detail.status_response, &detail.status_error) {
                (Some(status), _) => {
                    let snapshot = detail.selected_workspace_path().and_then(|workspace_path| {
                        status
                            .workspaces
                            .iter()
                            .find(|workspace| workspace.workspace_path == workspace_path)
                    });
                    body_lines.push(Line::from(format!(
                        "Materialization: {}",
                        snapshot
                            .and_then(|workspace| workspace.materialization.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    body_lines.push(Line::from(format!(
                        "Freshness: {}",
                        snapshot
                            .and_then(|workspace| workspace.freshness.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(format!(
                        "Readiness: {}",
                        workspace_scope_condition_summary(detail, &selected, "usable", true)
                    )));
                    body_lines.push(Line::from(format!(
                        "Acceptability: {}",
                        workspace_scope_condition_summary(detail, &selected, "acceptable", false)
                    )));
                    let blocked_reasons = detail.selected_workspace_lifecycle_block_reasons();
                    if !blocked_reasons.is_empty() {
                        body_lines.push(Line::from(""));
                        body_lines.push(Line::from("Lifecycle governance:"));
                        for reason in blocked_reasons {
                            body_lines.push(Line::from(reason));
                        }
                    }
                }
                (None, _) if detail.status_loading => {
                    body_lines.push(Line::from("Loading status information..."));
                }
                (None, Some(error)) => {
                    body_lines.push(Line::from("Status information could not be loaded."));
                    body_lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    body_lines.push(Line::from("Status information loads on demand."));
                    body_lines.push(Line::from("Press `r` in the detail panel to load it."));
                }
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
        DetailTab::Plan => {
            let target_summary = summarize_selected_workspaces(detail);
            let header_lines = vec![
                Line::from(format!("Selected node: {selected}")),
                Line::from(""),
                Line::from(target_summary),
            ];
            let mut body_lines = vec![
                Line::from(
                    "Press `c` to run converge. If nothing is explicitly selected, Yaffle converges the full environment.",
                ),
                Line::from(
                    "Press space on a workspace node to narrow the run. Lifecycle items ride along with their workspace.",
                ),
            ];
            if let Some(node) = detail.selected_node() {
                body_lines.push(Line::from(""));
                body_lines.push(Line::from(format!(
                    "Focused workspace: '{}'.",
                    node.workspace_path
                )));
                if detail.selected_workspaces.is_empty() {
                    body_lines.push(Line::from(
                        "Current run target: full environment. Press space here to converge just this workspace and its dependencies.",
                    ));
                }
            }
            if let Some(error) = detail.active_run_error() {
                if error.error.code == "environment_governance_blocked" {
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(
                        "Environment admission is blocked before infra starts.",
                    ));
                    body_lines.push(Line::from(error.error.message.clone()));
                }
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
        DetailTab::Apply => {
            let mut header_lines = vec![
                Line::from(format!("Selected node: {selected}")),
                Line::from(""),
            ];
            if let Some(error) = detail.active_run_error() {
                if error.error.code == "environment_governance_blocked" {
                    header_lines.push(Line::from("Environment run: blocked before infra"));
                    return DetailPanelContent {
                        header_lines,
                        body_lines: vec![Line::from(""), Line::from(error.error.message.clone())],
                    };
                }
            }
            if let Some((progress, running)) = detail.running_summary() {
                let workspace_run_state =
                    detail.selected_workspace_path().and_then(|workspace_path| {
                        detail.active_run_status_for_workspace(workspace_path)
                    });
                header_lines.push(Line::from(format!(
                    "Environment run: {}",
                    if running { "running" } else { "finished" }
                )));
                if let Some((workspace_state, workspace_phase)) = workspace_run_state {
                    header_lines.push(Line::from(format!(
                        "Workspace state: {}",
                        match workspace_state {
                            WorkspaceRunState::Pending => "waiting",
                            WorkspaceRunState::Running => "running",
                            WorkspaceRunState::Succeeded => "converged",
                            WorkspaceRunState::Failed => "failed",
                        }
                    )));
                    header_lines.push(Line::from(format!(
                        "Current phase: {}",
                        workspace_phase.map(phase_label).unwrap_or("not started")
                    )));
                }
                let mut body_lines = vec![Line::from(progress.detail.clone())];
                if let Some(message) = &progress.failure_message {
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(message.clone()));
                }
                if !detail.selected_workspace_log_lines().is_empty() {
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from("Recent activity:"));
                    for log in detail
                        .selected_workspace_log_lines()
                        .iter()
                        .rev()
                        .take(8)
                        .rev()
                    {
                        body_lines.push(render_workspace_log_line(log));
                    }
                }
                return DetailPanelContent {
                    header_lines,
                    body_lines,
                };
            }
            let mut body_lines = Vec::new();
            match (&detail.status_response, &detail.status_error) {
                (Some(status), _) => {
                    let snapshot = detail.selected_workspace_path().and_then(|workspace_path| {
                        status
                            .workspaces
                            .iter()
                            .find(|workspace| workspace.workspace_path == workspace_path)
                    });
                    body_lines.push(Line::from(format!(
                        "Materialization: {}",
                        snapshot
                            .and_then(|workspace| workspace.materialization.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    body_lines.push(Line::from(format!(
                        "Freshness: {}",
                        snapshot
                            .and_then(|workspace| workspace.freshness.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(status.result.summary.clone()));
                    let blocked_reasons = detail.selected_workspace_lifecycle_block_reasons();
                    if !blocked_reasons.is_empty() {
                        body_lines.push(Line::from(""));
                        body_lines.push(Line::from("Lifecycle governance:"));
                        for reason in blocked_reasons {
                            body_lines.push(Line::from(reason));
                        }
                    }
                }
                (None, _) if detail.status_loading => {
                    body_lines.push(Line::from("Loading status information..."));
                    body_lines.push(Line::from(
                        "You can keep navigating while Yaffle loads this in the background.",
                    ));
                }
                (None, Some(error)) => {
                    body_lines.push(Line::from("Status information could not be loaded."));
                    body_lines.push(Line::from("Press `r` in the detail panel to retry."));
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    body_lines.push(Line::from("Status information loads on demand."));
                    body_lines.push(Line::from("Press `r` in the detail panel to load it."));
                }
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
        DetailTab::Outputs => {
            let selected_workspace_path = detail.selected_workspace_path().unwrap_or("none");
            let header_lines = vec![
                Line::from(format!("Selected workspace: {selected_workspace_path}")),
                Line::from(""),
            ];
            let mut body_lines = Vec::new();
            if let Some(run) = detail.active_run.as_ref() {
                if let Some(outputs) = run.progress.workspace_outputs.get(selected_workspace_path) {
                    body_lines.push(Line::from(if run.running {
                        "Outputs captured so far during this converge:"
                    } else {
                        "Outputs captured during the last converge:"
                    }));
                    body_lines.push(Line::from(""));
                    if outputs.is_empty() {
                        body_lines.push(Line::from("No outputs captured for this workspace yet."));
                    } else {
                        for (name, output) in outputs {
                            let value = if output.sensitive == Some(true) {
                                "<sensitive>".to_string()
                            } else {
                                serde_json::to_string(&output.value)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            };
                            body_lines.push(Line::from(format!("{name} = {value}")));
                        }
                    }
                    return DetailPanelContent {
                        header_lines,
                        body_lines,
                    };
                }
                if run.running {
                    body_lines.push(Line::from(
                        "Outputs will appear here as workspaces finish and publish them.",
                    ));
                    return DetailPanelContent {
                        header_lines,
                        body_lines,
                    };
                }
            }
            match (&detail.outputs_response, &detail.outputs_error) {
                (Some(outputs_response), _) => {
                    let outputs = outputs_response
                        .workspace_outputs
                        .get(selected_workspace_path)
                        .cloned()
                        .unwrap_or_default();
                    if outputs.is_empty() {
                        body_lines.push(Line::from("No outputs found for this workspace yet."));
                    } else {
                        for (name, output) in outputs {
                            let value = if output.sensitive == Some(true) {
                                "<sensitive>".to_string()
                            } else {
                                serde_json::to_string(&output.value)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            };
                            body_lines.push(Line::from(format!("{name} = {value}")));
                        }
                    }
                }
                (None, _) if detail.outputs_loading => {
                    body_lines.push(Line::from("Loading outputs..."));
                    body_lines.push(Line::from(
                        "You can keep navigating while Yaffle loads this in the background.",
                    ));
                }
                (None, Some(error)) => {
                    body_lines.push(Line::from("Outputs could not be loaded."));
                    body_lines.push(Line::from("Press `r` in the detail panel to retry."));
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    body_lines.push(Line::from("Outputs load on demand."));
                    body_lines.push(Line::from("Press `r` in the detail panel to load them."));
                }
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
        DetailTab::Activation | DetailTab::Verification => {
            let phase = match detail.tab {
                DetailTab::Activation => "activation",
                DetailTab::Verification => "verification",
                _ => "lifecycle",
            };
            let selected_workspace_path = detail.selected_workspace_path().unwrap_or("none");
            let header_lines = vec![
                Line::from(format!("Selected workspace: {selected_workspace_path}")),
                Line::from(format!("{} lifecycle items", title_case(phase))),
                Line::from(""),
            ];
            let mut body_lines = Vec::new();
            match (&detail.status_response, &detail.status_error) {
                (Some(_), _) => {
                    let items = detail.selected_workspace_lifecycle_items(phase);
                    if items.is_empty() {
                        body_lines.push(Line::from(format!(
                            "No {phase} lifecycle items for this workspace."
                        )));
                    } else {
                        for item in items {
                            render_lifecycle_item_lines(item, phase, &mut body_lines);
                        }
                    }
                }
                (None, _) if detail.status_loading => {
                    body_lines.push(Line::from("Loading lifecycle status..."));
                }
                (None, Some(error)) => {
                    body_lines.push(Line::from("Lifecycle status could not be loaded."));
                    body_lines.push(Line::from("Press `r` in the detail panel to retry."));
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    body_lines.push(Line::from("Lifecycle status loads on demand."));
                    body_lines.push(Line::from("Press `r` in the detail panel to load it."));
                }
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
        DetailTab::Runs => {
            let selected_workspace_path = detail.selected_workspace_path().unwrap_or("none");
            let header_lines = vec![
                Line::from(format!("Selected workspace: {selected_workspace_path}")),
                Line::from("Run history"),
                Line::from(""),
            ];
            let mut body_lines = Vec::new();
            if let Some(run) = detail.active_run.as_ref() {
                if let Some((state, phase)) =
                    detail.active_run_status_for_workspace(selected_workspace_path)
                {
                    body_lines.push(Line::from(format!(
                        "Current converge: {}",
                        if run.running { "running" } else { "finished" }
                    )));
                    body_lines.push(Line::from(format!(
                        "Workspace state: {}",
                        match state {
                            WorkspaceRunState::Pending => "waiting",
                            WorkspaceRunState::Running => "running",
                            WorkspaceRunState::Succeeded => "succeeded",
                            WorkspaceRunState::Failed => "failed",
                        }
                    )));
                    body_lines.push(Line::from(format!(
                        "Current phase: {}",
                        phase.map(phase_label).unwrap_or("not started")
                    )));
                }
                if let Some(error) = run.last_error.as_ref() {
                    body_lines.push(Line::from(""));
                    body_lines.push(Line::from(format!("Last error: {}", error.error.message)));
                }
            } else {
                body_lines.push(Line::from(
                    "No local converge run has been started from this TUI session yet.",
                ));
            }
            DetailPanelContent {
                header_lines,
                body_lines,
            }
        }
    }
}

fn summarize_selected_workspaces(detail: &LocalEnvironmentDetailState) -> String {
    let selected = ordered_selected_workspaces(detail);

    if selected.is_empty() {
        let focused = detail.selected_workspace_path().unwrap_or("none");
        return format!(
            "Converge target: full environment • focused workspace: {}",
            focused
        );
    }

    let preview = selected
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if selected.len() > 3 { ", ..." } else { "" };

    format!(
        "Converge target: selected workspaces ({}) • {}{}",
        selected.len(),
        preview,
        suffix
    )
}

fn ordered_selected_workspaces(detail: &LocalEnvironmentDetailState) -> Vec<String> {
    detail
        .graph
        .topological_order()
        .unwrap_or_else(|_| detail.graph.workspace_paths())
        .into_iter()
        .filter(|workspace| detail.selected_workspaces.contains(workspace.as_str()))
        .collect()
}

fn title_case(value: &str) -> &'static str {
    match value {
        "activation" => "Activation",
        "verification" => "Verification",
        _ => "Lifecycle",
    }
}

fn humanize_lifecycle_key(key: &str) -> String {
    let cleaned = key
        .trim()
        .trim_start_matches("preview-")
        .trim_start_matches("activation-")
        .trim_start_matches("verification-");
    let source = if cleaned.is_empty() { key } else { cleaned };
    let words = source
        .split(['-', '_'])
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    format!(
                        "{}{}",
                        first.to_ascii_uppercase(),
                        chars.as_str().to_ascii_lowercase()
                    )
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>();

    if words.is_empty() {
        key.to_string()
    } else {
        words.join(" ")
    }
}

fn lifecycle_scope_copy(phase: &str, scopes: &[String]) -> String {
    if scopes.is_empty() {
        return match phase {
            "verification" => "Confirms the preview through an external check.".to_string(),
            _ => "Waits for an external ready signal.".to_string(),
        };
    }

    match phase {
        "verification" => format!("Confirms {}.", scopes.join(" + ")),
        _ => format!("Unlocks {}.", scopes.join(" + ")),
    }
}

fn lifecycle_state_copy(phase: &str, state: &str, summary: Option<&str>) -> String {
    if let Some(summary) = summary.filter(|summary| !summary.trim().is_empty()) {
        return summary.to_string();
    }

    match (phase, state) {
        ("activation", "succeeded") => "Preview is live.".to_string(),
        ("verification", "succeeded") => "Checks passed.".to_string(),
        (_, "running") => "External signal is in flight.".to_string(),
        (_, "pending") => "Waiting for external signal.".to_string(),
        (_, "blocked") => "Policy blocked this gate.".to_string(),
        (_, "degraded") => "Gate settled with warnings.".to_string(),
        (_, "failed") => "Gate failed.".to_string(),
        _ => format!("State: {state}"),
    }
}

fn render_lifecycle_item_lines(item: &Value, phase: &str, body_lines: &mut Vec<Line>) {
    let key = item.get("key").and_then(Value::as_str).unwrap_or("unknown");
    let state = item
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let summary = item.get("summary").and_then(Value::as_str);
    let reason = item.get("reason").and_then(Value::as_str);
    let scopes = item
        .get("scopes")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !body_lines.is_empty() {
        body_lines.push(Line::from(""));
    }
    body_lines.push(Line::from(format!(
        "{}: {}",
        humanize_lifecycle_key(key),
        lifecycle_state_copy(phase, state, summary)
    )));
    body_lines.push(Line::from(
        reason
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| lifecycle_scope_copy(phase, &scopes)),
    ));
    body_lines.push(Line::from(format!(
        "Scopes: {}",
        if scopes.is_empty() {
            "advisory".to_string()
        } else {
            scopes.join(", ")
        }
    )));

    if let Some(events) = item.get("events").and_then(Value::as_array) {
        if !events.is_empty() {
            body_lines.push(Line::from("Events:"));
            for event in events {
                let event_type = event
                    .get("eventType")
                    .and_then(Value::as_str)
                    .unwrap_or("event");
                body_lines.push(Line::from(format!(
                    "- {}: {}",
                    title_case_lifecycle_event(event_type),
                    format_lifecycle_event_summary(event)
                )));
            }
        }
    }
}

fn title_case_lifecycle_event(value: &str) -> &'static str {
    match value {
        "created" => "Gate armed",
        "dispatched" => "Sent outward",
        "dispatch_failed" => "Dispatch failed",
        "blocked" => "Policy blocked",
        "callback" => "External result",
        _ => "Event",
    }
}

fn format_lifecycle_event_summary(event: &Value) -> String {
    let Some(event_type) = event.get("eventType").and_then(Value::as_str) else {
        return "event recorded".to_string();
    };
    let payload = event.get("payload").and_then(Value::as_object);

    match event_type {
        "callback" => {
            let status = payload
                .and_then(|payload| payload.get("status"))
                .and_then(Value::as_str)
                .map(|status| match status {
                    "succeeded" => "passed",
                    "running" => "in flight",
                    "pending" => "queued",
                    "degraded" => "warning",
                    "blocked" => "policy blocked",
                    "failed" => "failed",
                    _ => status,
                })
                .unwrap_or("updated");
            let summary = payload
                .and_then(|payload| payload.get("summary"))
                .and_then(Value::as_str);
            summary
                .map(|summary| format!("{status}: {summary}"))
                .unwrap_or_else(|| status.to_string())
        }
        "blocked" => payload
            .and_then(|payload| payload.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("blocked by governance")
            .to_string(),
        "dispatched" => "Yaffle handed the gate to the external system".to_string(),
        "dispatch_failed" => payload
            .and_then(|payload| payload.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("the external handoff failed")
            .to_string(),
        "created" => "Yaffle is waiting for the external ready signal".to_string(),
        _ => payload
            .and_then(|payload| serde_json::to_string(payload).ok())
            .unwrap_or_else(|| "event recorded".to_string()),
    }
}

fn workspace_lifecycle_phase_summary(
    detail: &LocalEnvironmentDetailState,
    workspace_path: &str,
    phase: &str,
) -> String {
    let Some(status) = detail.status_response.as_ref() else {
        return "?".to_string();
    };
    let Some(items) = status
        .workspaces
        .iter()
        .find(|workspace| workspace.workspace_path == workspace_path)
        .and_then(|workspace| workspace.lifecycle.as_ref())
        .and_then(|lifecycle| lifecycle.get("items"))
        .and_then(Value::as_array)
    else {
        return "idle".to_string();
    };

    let mut states = BTreeMap::<String, usize>::new();
    let mut total = 0usize;
    for item in items {
        if item.get("phase").and_then(Value::as_str) != Some(phase) {
            continue;
        }
        total += 1;
        let state = item
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *states.entry(state).or_default() += 1;
    }

    if total == 0 {
        return "idle".to_string();
    }
    if states.len() == 1 {
        return states
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "idle".to_string());
    }
    for state in ["failed", "blocked", "running", "pending", "degraded"] {
        if let Some(count) = states.get(state) {
            return format!("{state} {count}/{total}");
        }
    }
    format!("mixed {total}")
}

fn workspace_lifecycle_phase_state(
    detail: &LocalEnvironmentDetailState,
    workspace_path: &str,
    phase: &str,
) -> Option<String> {
    let summary = workspace_lifecycle_phase_summary(detail, workspace_path, phase);
    if summary == "idle" || summary == "?" {
        return None;
    }
    Some(
        summary
            .split_whitespace()
            .next()
            .unwrap_or("pending")
            .to_string(),
    )
}

fn workspace_scope_condition_summary(
    detail: &LocalEnvironmentDetailState,
    workspace_path: &str,
    scope: &str,
    allow_degraded: bool,
) -> String {
    let mut states = BTreeMap::<String, usize>::new();
    let mut total = 0usize;
    for item in lifecycle_items_for_workspace(detail, workspace_path) {
        let scopes = item
            .get("scopes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        if !scopes.contains(&scope) {
            continue;
        }
        total += 1;
        let state = item
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *states.entry(state).or_default() += 1;
    }

    if total == 0 {
        return "met (no scoped lifecycle requirements)".to_string();
    }
    if states.get("failed").copied().unwrap_or(0) > 0 {
        return "unmet (failed lifecycle work)".to_string();
    }
    if states.get("blocked").copied().unwrap_or(0) > 0 {
        return "unmet (blocked lifecycle work)".to_string();
    }
    if states.get("running").copied().unwrap_or(0) > 0
        || states.get("pending").copied().unwrap_or(0) > 0
    {
        return "unmet (progressing lifecycle work)".to_string();
    }
    if !allow_degraded && states.get("degraded").copied().unwrap_or(0) > 0 {
        return "unmet (degraded lifecycle work)".to_string();
    }

    "met".to_string()
}

fn lifecycle_items_for_workspace<'a>(
    detail: &'a LocalEnvironmentDetailState,
    workspace_path: &str,
) -> Vec<&'a Value> {
    detail
        .status_response
        .as_ref()
        .and_then(|status| {
            status
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_path == workspace_path)
        })
        .and_then(|workspace| workspace.lifecycle.as_ref())
        .and_then(|lifecycle| lifecycle.get("items"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect()
}

fn load_environment_detail(
    repo_root: &Path,
    config: &yaffle_config::YaffleConfig,
    environment_name: &str,
) -> Result<LocalEnvironmentDetailState, CliFailure> {
    let current_namespace = infer_repo_namespace(repo_root);
    let graph = resolve_workspace_graph(
        repo_root,
        config,
        Some(environment_name),
        &WorkspaceGraphOptions {
            allowed_hosts: None,
            current_namespace: current_namespace.clone(),
        },
    )
    .map_err(|error| {
        command_error(
            false,
            Some(EngineOperation::Graph),
            Some(EnvironmentTarget {
                environment: environment_name.to_string(),
            }),
            Some(WorkspaceSelection::default()),
            "graph_resolution_failed",
            format!("Failed to resolve environment graph for '{environment_name}': {error}"),
        )
    })?;

    let dag_nodes = build_environment_dag_nodes(
        config,
        &graph,
        environment_name,
        current_namespace.as_deref(),
    );
    let levels = build_graph_levels(&dag_nodes);

    Ok(LocalEnvironmentDetailState {
        environment_name: environment_name.to_string(),
        graph,
        dag_nodes,
        levels,
        selected_level: 0,
        selected_row: 0,
        selected_workspaces: std::collections::BTreeSet::new(),
        focus: ShellFocus::Graph,
        tab: DetailTab::Overview,
        detail_spotlight: false,
        detail_scroll: 0,
        status_response: None,
        status_error: None,
        status_loading: false,
        status_rx: None,
        outputs_response: None,
        outputs_error: None,
        outputs_loading: false,
        outputs_rx: None,
        active_run: None,
        follow_running_workspace: true,
    })
}

fn load_local_config_context(
    working_dir: &Path,
) -> Result<(PathBuf, yaffle_config::YaffleConfig), CliFailure> {
    let mut current: Option<&Path> = Some(working_dir);
    while let Some(path) = current {
        let candidate = path.join("yaffle.toml");
        if candidate.is_file() {
            let config_text = std::fs::read_to_string(&candidate).map_err(|error| {
                command_error(
                    false,
                    None,
                    None,
                    None,
                    "config_read_failed",
                    format!("Failed to read '{}': {error}", candidate.display()),
                )
            })?;
            let config = yaffle_config::parse_yaffle_toml(&config_text).map_err(|error| {
                command_error(
                    false,
                    None,
                    None,
                    None,
                    "config_parse_failed",
                    error.to_string(),
                )
            })?;
            return Ok((path.to_path_buf(), config));
        }
        current = path.parent();
    }

    Err(command_error(
        false,
        None,
        None,
        None,
        "config_not_found",
        "Could not find `yaffle.toml` in this directory or any parent directory.",
    ))
}

fn resolve_tui_capability(repo_root: &Path) -> TuiCapability {
    let Ok(status) = load_local_cloud_auth_status() else {
        return TuiCapability {
            mode: TuiCapabilityMode::AnonymousLocal,
            label: "Local only".to_string(),
            detail: "Runs use this machine.".to_string(),
            repo_full_name: None,
            action_label: None,
            action_url: None,
        };
    };

    let Some(principal) = status.stored_principal else {
        return TuiCapability {
            mode: TuiCapabilityMode::AnonymousLocal,
            label: "Local only".to_string(),
            detail: "Yaffle Cloud is not connected.".to_string(),
            repo_full_name: None,
            action_label: Some("Sign in / register".to_string()),
            action_url: cloud_web_url("/"),
        };
    };

    if status.expired {
        return TuiCapability {
            mode: TuiCapabilityMode::AnonymousLocal,
            label: "Local only".to_string(),
            detail: "Cloud session expired. Run `yaffle cloud login` to reconnect.".to_string(),
            repo_full_name: None,
            action_label: Some("Sign in / register".to_string()),
            action_url: cloud_web_url("/"),
        };
    }

    if principal.principal_type == StoredPrincipalType::AnonymousSession {
        return TuiCapability {
            mode: TuiCapabilityMode::AnonymousLocal,
            label: "Local only".to_string(),
            detail: "Temporary local session.".to_string(),
            repo_full_name: None,
            action_label: Some("Sign in / register".to_string()),
            action_url: cloud_web_url("/"),
        };
    }

    let Some(repo_full_name) = try_infer_repo_full_name_for_tui(repo_root) else {
        return TuiCapability {
            mode: TuiCapabilityMode::AccountLocal,
            label: "Free cloud".to_string(),
            detail: "Cloud account connected.".to_string(),
            repo_full_name: None,
            action_label: None,
            action_url: None,
        };
    };

    if !local_first_feature_token_configured() {
        return TuiCapability {
            mode: TuiCapabilityMode::AccountLocal,
            label: "Free cloud".to_string(),
            detail: "Cloud account connected.".to_string(),
            repo_full_name: Some(repo_full_name),
            action_label: None,
            action_url: None,
        };
    }

    match get_cloud_cli_capabilities(&principal, &repo_full_name) {
        Ok(capabilities) if capabilities.remote_converge.available => TuiCapability {
            mode: TuiCapabilityMode::AccountRemote,
            label: "Paid cloud".to_string(),
            detail: capabilities.remote_converge.message,
            repo_full_name: Some(repo_full_name),
            action_label: None,
            action_url: None,
        },
        Ok(capabilities) => TuiCapability {
            mode: TuiCapabilityMode::AccountLocal,
            label: "Free cloud".to_string(),
            detail: capabilities.remote_converge.message,
            repo_full_name: Some(repo_full_name),
            action_label: capabilities
                .remote_converge
                .upgrade_url
                .as_ref()
                .map(|_| "Upgrade".to_string()),
            action_url: capabilities
                .remote_converge
                .upgrade_url
                .as_deref()
                .and_then(cloud_web_url),
        },
        Err(_) => TuiCapability {
            mode: TuiCapabilityMode::AccountLocal,
            label: "Free cloud".to_string(),
            detail: "Cloud account connected.".to_string(),
            repo_full_name: Some(repo_full_name),
            action_label: None,
            action_url: None,
        },
    }
}

fn cloud_web_url(path: &str) -> Option<String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        return Some(path.to_string());
    }

    let base_url = module_api_base_url().ok()?;
    let separator = if path.starts_with('/') { "" } else { "/" };
    Some(format!(
        "{}{}{}",
        base_url.trim_end_matches('/'),
        separator,
        path
    ))
}

fn try_infer_repo_full_name_for_tui(working_dir: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(working_dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_github_repo_full_name(&remote)
}

fn discover_tui_environments(
    repo_root: &Path,
    config: &yaffle_config::YaffleConfig,
    capability: &TuiCapability,
) -> Vec<LocalEnvironmentEntry> {
    if capability.mode == TuiCapabilityMode::AccountRemote {
        if let Some(repo_full_name) = capability.repo_full_name.as_deref() {
            if let Ok(status) = load_local_cloud_auth_status() {
                if let Some(principal) = status.stored_principal {
                    if !status.expired && principal.principal_type == StoredPrincipalType::Account {
                        if let Ok(inventory) = get_cloud_cli_inventory(&principal, repo_full_name) {
                            return cloud_inventory_to_environment_entries(repo_root, &inventory);
                        }
                    }
                }
            }
        }
    }

    discover_local_environments(repo_root, config)
}

fn cloud_inventory_to_environment_entries(
    repo_root: &Path,
    inventory: &CloudCliInventory,
) -> Vec<LocalEnvironmentEntry> {
    let local_state_envs = discover_local_state_environment_names(repo_root);
    let mut environments = inventory
        .environments
        .iter()
        .map(|environment| LocalEnvironmentEntry {
            name: environment.environment_name.clone(),
            kind: match environment.environment_kind.as_str() {
                "transient" => "transient".to_string(),
                _ => "named".to_string(),
            },
            workspace_count: environment.workspace_count,
            status_vector: environment_status_vector(&environment.status_vector),
            local_state_detected: local_state_envs.contains(&environment.environment_name),
            repo: Some(environment.repo.clone()),
            origin: Some(cloud_environment_origin(environment)),
            status: Some(environment.status.clone()),
            head_sha: Some(environment.head_sha.clone()),
            updated_at: Some(environment.updated_at.clone()),
            actor: environment.actor_login.clone(),
        })
        .collect::<Vec<_>>();

    environments.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.kind.cmp(&right.kind))
    });
    environments
}

fn cloud_environment_origin(environment: &yaffle_engine::CloudCliInventoryEnvironment) -> String {
    if environment.source_kind.as_deref() == Some("github_pull_request") {
        return environment
            .pr_number
            .map(|number| format!("PR #{number}"))
            .unwrap_or_else(|| "pull request".to_string());
    }

    let ref_name = environment
        .git_ref
        .strip_prefix("refs/heads/")
        .or_else(|| environment.git_ref.strip_prefix("refs/tags/"))
        .unwrap_or(environment.git_ref.as_str());
    if environment.git_ref.starts_with("refs/tags/") {
        format!("tag {ref_name}")
    } else {
        format!("branch {ref_name}")
    }
}

fn environment_status_vector(
    status_vector: &[CloudCliInventoryStatusCount],
) -> Vec<EnvironmentStatusCount> {
    status_vector
        .iter()
        .map(|item| EnvironmentStatusCount {
            status: item.status.clone(),
            count: item.count,
        })
        .collect()
}

fn discover_local_state_environment_names(repo_root: &Path) -> std::collections::BTreeSet<String> {
    let mut local_state_envs = std::collections::BTreeSet::new();
    let state_root = repo_root.join(".yaffle").join("state");
    if let Ok(entries) = std::fs::read_dir(state_root) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    local_state_envs.insert(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }

    local_state_envs
}

fn discover_local_environments(
    repo_root: &Path,
    config: &yaffle_config::YaffleConfig,
) -> Vec<LocalEnvironmentEntry> {
    let local_state_envs = discover_local_state_environment_names(repo_root);

    let mut environments = config
        .environments
        .iter()
        .map(|environment| LocalEnvironmentEntry {
            name: environment.name.clone(),
            kind: "named".to_string(),
            workspace_count: count_workspaces_for_environment(config, &environment.name),
            status_vector: Vec::new(),
            local_state_detected: local_state_envs.contains(&environment.name),
            repo: None,
            origin: None,
            status: None,
            head_sha: None,
            updated_at: None,
            actor: None,
        })
        .collect::<Vec<_>>();

    for environment in local_state_envs {
        if environments.iter().any(|item| item.name == environment) {
            continue;
        }
        environments.push(LocalEnvironmentEntry {
            workspace_count: count_workspaces_for_environment(config, &environment),
            kind: match environment_kind_for_name(config, &environment) {
                EnvironmentKind::Named => "named".to_string(),
                EnvironmentKind::Transient => "transient".to_string(),
            },
            status_vector: Vec::new(),
            local_state_detected: true,
            name: environment,
            repo: None,
            origin: None,
            status: None,
            head_sha: None,
            updated_at: None,
            actor: None,
        });
    }

    environments.sort_by(|left, right| left.name.cmp(&right.name));
    environments
}

fn count_workspaces_for_environment(
    config: &yaffle_config::YaffleConfig,
    environment_name: &str,
) -> usize {
    config
        .workspaces
        .iter()
        .filter(|workspace| match &workspace.environments {
            yaffle_config::EnvironmentSelector::All => {
                environment_kind_for_name(config, environment_name) == EnvironmentKind::Transient
            }
            yaffle_config::EnvironmentSelector::Named(names) => {
                names.iter().any(|name| name == environment_name)
            }
        })
        .count()
}

fn build_environment_dag_nodes(
    _config: &yaffle_config::YaffleConfig,
    graph: &ResolvedWorkspaceGraph,
    _environment_name: &str,
    _canonical_repo_namespace: Option<&str>,
) -> Vec<EnvironmentDagNode> {
    let order = graph
        .topological_order()
        .unwrap_or_else(|_| graph.workspace_paths());
    let mut nodes = Vec::new();

    for workspace_path in order {
        let dependencies = graph
            .workspace(&workspace_path)
            .map(|workspace| workspace.dependencies.clone())
            .unwrap_or_default();
        nodes.push(EnvironmentDagNode {
            id: workspace_path.clone(),
            workspace_path: workspace_path.clone(),
            label: workspace_path.clone(),
            dependencies,
            kind: EnvironmentDagNodeKind::Workspace,
        });
    }

    nodes
}

fn build_graph_levels(nodes: &[EnvironmentDagNode]) -> Vec<Vec<String>> {
    let ordered_ids = nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
    let mut stages = BTreeMap::<String, usize>::new();
    for node_id in &ordered_ids {
        let dependencies = nodes
            .iter()
            .find(|node| node.id == *node_id)
            .map(|node| node.dependencies.clone())
            .unwrap_or_default();
        let stage = dependencies
            .iter()
            .map(|dependency| stages.get(dependency).copied().unwrap_or(0) + 1)
            .max()
            .unwrap_or(0);
        stages.insert(node_id.clone(), stage);
    }

    let max_stage = stages.values().copied().max().unwrap_or(0);
    let mut levels = vec![Vec::new(); max_stage + 1];
    for node_id in ordered_ids {
        let stage = stages.get(&node_id).copied().unwrap_or(0);
        levels[stage].push(node_id);
    }
    levels
}

fn infer_repo_namespace(repo_root: &Path) -> Option<String> {
    let git_config = repo_root.join(".git").join("config");
    let config = std::fs::read_to_string(git_config).ok()?;
    let remote_url = find_git_remote_url(&config)?;
    namespace_from_remote_url(&remote_url)
}

fn find_git_remote_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    let mut fallback = None;

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[remote ") {
            in_origin = trimmed == "[remote \"origin\"]";
            continue;
        }
        if let Some(url) = trimmed.strip_prefix("url = ") {
            let value = url.trim().to_string();
            if in_origin {
                return Some(value);
            }
            if fallback.is_none() {
                fallback = Some(value);
            }
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
            let path = path.trim_start_matches('/');
            let mut parts = path.split('/');
            let owner = parts.next()?;
            let repo = parts.next()?.trim_end_matches(".git");
            if !owner.is_empty() && !repo.is_empty() {
                return Some(format!("{owner}--{repo}"));
            }
        }
    }

    None
}

fn run_environment_operation(
    operation: EngineOperation,
    command: EnvironmentOnlyCommand,
) -> CliResult {
    run_engine_request(
        command.json,
        EngineRequest {
            operation,
            target: Some(EnvironmentTarget {
                environment: command.env,
            }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
    )
}

fn run_wait(command: WaitCommand) -> CliResult {
    run_engine_request(
        command.json,
        EngineRequest {
            operation: EngineOperation::Wait,
            target: Some(EnvironmentTarget {
                environment: command.env,
            }),
            selection: WorkspaceSelection::default(),
            wait_for: Some(command.condition),
        },
    )
}

fn run_outputs(command: OutputsCommand) -> CliResult {
    run_engine_request(
        command.json,
        EngineRequest {
            operation: EngineOperation::Outputs,
            target: Some(EnvironmentTarget {
                environment: command.env,
            }),
            selection: WorkspaceSelection {
                workspaces: command.workspaces,
            },
            wait_for: None,
        },
    )
}

fn run_graph(command: GraphCommand) -> CliResult {
    run_engine_request(
        command.json,
        EngineRequest {
            operation: EngineOperation::Graph,
            target: command
                .env
                .map(|environment| EnvironmentTarget { environment }),
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
    )
}

fn run_doctor() -> CliResult {
    run_engine_request(
        false,
        EngineRequest {
            operation: EngineOperation::Doctor,
            target: None,
            selection: WorkspaceSelection::default(),
            wait_for: None,
        },
    )
}

fn run_tf(command: TfCommands) -> CliResult {
    match command {
        TfCommands::Login(command) => run_tf_login(command),
    }
}

fn run_tf_login(command: TfLoginCommand) -> CliResult {
    let prior_cloud_auth_status = load_local_cloud_auth_status().ok();
    let working_dir = std::env::current_dir().map_err(|error| {
        command_error(
            false,
            None,
            Some(EnvironmentTarget {
                environment: command.env.clone(),
            }),
            Some(WorkspaceSelection {
                workspaces: vec![command.workspace.clone()],
            }),
            "current_directory_unavailable",
            format!("Failed to resolve the current working directory: {error}"),
        )
    })?;

    let exports = prepare_tf_login_exports(&working_dir, &command.env, &command.workspace)
        .map_err(|payload| CliFailure {
            json: false,
            payload,
        })?;

    maybe_print_guest_bootstrap_notice(prior_cloud_auth_status.as_ref());

    print!("{exports}");
    Ok(())
}

fn run_cloud(command: CloudCommands) -> CliResult {
    match command {
        CloudCommands::Login => run_cloud_login(),
        CloudCommands::Logout => run_cloud_logout(),
        CloudCommands::Status => run_cloud_status(),
    }
}

fn run_cloud_login() -> CliResult {
    let prior_status = load_local_cloud_auth_status().ok();
    let callback_listener = bind_cloud_login_listener().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_login_failed",
            format!("Failed to open a local callback port for cloud login: {error}"),
        )
    })?;
    let callback_port = callback_listener
        .local_addr()
        .map_err(|error| {
            command_error(
                false,
                None,
                None,
                None,
                "cloud_login_failed",
                format!("Failed to resolve the local callback port: {error}"),
            )
        })?
        .port();

    let code_verifier = generate_pkce_verifier().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_login_failed",
            format!("Failed to generate a secure login verifier: {error}"),
        )
    })?;
    let code_challenge = pkce_challenge_for_verifier(&code_verifier);
    let state = generate_pkce_verifier().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_login_failed",
            format!("Failed to generate login state: {error}"),
        )
    })?;
    let redirect_uri = format!("http://localhost:{callback_port}/callback");
    let authorize_url = build_cloud_cli_authorize_url(&redirect_uri, &code_challenge, &state)
        .map_err(|error| {
            command_error(
                false,
                None,
                None,
                None,
                "cloud_login_failed",
                format!("Failed to build the cloud login URL: {error}"),
            )
        })?;

    eprintln!("Opening your browser for Yaffle Cloud login...");
    if !open_browser(&authorize_url) {
        eprintln!("Open this URL manually: {authorize_url}");
    } else {
        eprintln!("If the browser does not open, visit: {authorize_url}");
    }

    let callback = wait_for_cloud_login_callback(callback_listener, &state)
        .map_err(|error| command_error(false, None, None, None, "cloud_login_failed", error))?;
    let login = exchange_cloud_cli_login_code(
        &callback.code,
        &code_verifier,
        &redirect_uri,
        prior_status
            .as_ref()
            .and_then(|status| status.stored_principal.as_ref()),
    )
    .map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_login_failed",
            format!("Yaffle Cloud login failed: {error}"),
        )
    })?;

    let status = load_local_cloud_auth_status().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_login_failed",
            format!(
                "Logged in successfully, but failed to inspect local Yaffle Cloud auth: {error}"
            ),
        )
    })?;

    println!(
        "{}",
        render_cloud_transition(&render_cloud_login_success(&login), &status)
    );
    Ok(())
}

fn run_cloud_status() -> CliResult {
    let status = load_local_cloud_auth_status().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_status_failed",
            format!("Failed to inspect local Yaffle Cloud auth: {error}"),
        )
    })?;

    println!("{}", render_cloud_status(&status));
    Ok(())
}

fn run_cloud_logout() -> CliResult {
    let status = load_local_cloud_auth_status().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_logout_failed",
            format!("Failed to inspect local Yaffle Cloud auth: {error}"),
        )
    })?;
    let removed = clear_local_cloud_auth().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_logout_failed",
            format!("Failed to clear local Yaffle Cloud auth: {error}"),
        )
    })?;

    let action = if removed {
        match status.stored_principal.as_ref().map(|principal| principal.principal_type) {
            Some(StoredPrincipalType::Account) => "Signed this machine out of Yaffle Cloud. Run `yaffle cloud login` to connect your account again.".to_string(),
            _ => "Removed this machine's temporary Yaffle guest session. Run `yaffle converge` to start another guest session, or `yaffle cloud login` to connect your account.".to_string(),
        }
    } else {
        "This machine was already signed out of Yaffle Cloud.".to_string()
    };

    let current_status = load_local_cloud_auth_status().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "cloud_logout_failed",
            format!(
                "Signed out successfully, but failed to inspect local Yaffle Cloud auth: {error}"
            ),
        )
    })?;

    println!("{}", render_cloud_transition(&action, &current_status));

    Ok(())
}

fn render_cloud_status(status: &LocalCloudAuthStatus) -> String {
    render_cloud_status_with_note(status, local_backend_access_note())
}

fn render_cloud_status_with_note(status: &LocalCloudAuthStatus, local_dev_note: &str) -> String {
    let local_dev_note = format!("Local dev note: {local_dev_note}");

    let Some(principal) = &status.stored_principal else {
        return format!(
            "Yaffle Cloud: not connected\n\nThis machine is not connected to Yaffle Cloud yet.\n\nWhat you can do next:\n- run `yaffle converge` to continue as a temporary guest\n- run `yaffle tf login` to use raw OpenTofu with Yaffle-backed auth\n- run `yaffle cloud login` to connect your account\n\n{}",
            local_dev_note,
        );
    };

    let expires_at = principal.expires_at.as_deref().unwrap_or("unknown");

    if principal.principal_type == StoredPrincipalType::Account {
        let identity = describe_identity(principal);
        if status.expired {
            return format!(
                "Yaffle Cloud: account session expired\n\nThis machine was previously connected as {identity}, but that session has expired.\n\nWhat you can do next:\n- run `yaffle cloud login` to reconnect your account\n\n{}",
                local_dev_note,
            );
        }

        return format!(
            "Yaffle Cloud: connected as {identity}\n\nThis machine is signed in to Yaffle Cloud and ready for local-first workflows.\n\nWhat you can do next:\n- run `yaffle converge`\n- run `yaffle tf login`\n\nSession expires: {expires_at}\n{}",
            local_dev_note,
        );
    }

    if status.expired {
        return format!(
            "Yaffle Cloud: temporary guest session expired\n\nThis machine's previous guest session has expired.\n\nWhat you can do next:\n- run `yaffle converge` to start a new temporary guest session\n- run `yaffle tf login` to use raw OpenTofu with Yaffle-backed auth\n- run `yaffle cloud login` to connect your account\n\n{}",
            local_dev_note,
        );
    }

    format!(
        "Yaffle Cloud: connected as a temporary guest\n\nThis machine can use Yaffle Cloud for hosted modules and local-first auth. Guest sessions stay on the machine where they were created.\n\nWhat you can do next:\n- run `yaffle converge`\n- run `yaffle tf login`\n- run `yaffle cloud login` to save this setup to your account\n\nGuest session expires: {expires_at}\n{}",
        local_dev_note,
    )
}

fn render_cloud_login_success(login: &CloudCliLoginResult) -> String {
    let principal = &login.principal;
    let identity = describe_identity(principal);

    if login.converted_from_anonymous {
        return format!(
            "Logged into Yaffle Cloud as {identity}. Your temporary guest setup on this machine has been upgraded to your account, and its hosted output modules came with it."
        );
    }

    format!(
        "Logged into Yaffle Cloud as {identity}. This machine is now connected to your account."
    )
}

fn render_cloud_transition(action: &str, status: &LocalCloudAuthStatus) -> String {
    format!("{action}\n\n{}", render_cloud_status(status))
}

fn run_completion(command: CompletionCommand) -> CliResult {
    let mut root = Cli::command();
    generate(command.shell, &mut root, "yaffle", &mut io::stdout());
    Ok(())
}

fn run_engine_request(json: bool, request: EngineRequest) -> CliResult {
    let prior_cloud_auth_status = if json {
        None
    } else {
        load_local_cloud_auth_status().ok()
    };
    let working_dir = current_working_directory(json, &request)?;
    let response =
        execute(&request, &working_dir).map_err(|payload| CliFailure { json, payload })?;

    if !json {
        maybe_print_guest_bootstrap_notice(prior_cloud_auth_status.as_ref());
    }

    render_response(json, &response)
}

fn maybe_print_guest_bootstrap_notice(prior_status: Option<&LocalCloudAuthStatus>) {
    let Some(prior_status) = prior_status else {
        return;
    };

    let created_new_guest_session = prior_status.stored_principal.is_none() || prior_status.expired;
    if !created_new_guest_session {
        return;
    }

    let Ok(current_status) = load_local_cloud_auth_status() else {
        return;
    };
    let Some(principal) = current_status.stored_principal.as_ref() else {
        return;
    };
    if current_status.expired {
        return;
    }
    if principal.principal_type != StoredPrincipalType::AnonymousSession {
        return;
    }

    eprintln!(
        "Connected this machine to Yaffle Cloud as a temporary guest. Yaffle can now use hosted modules and local-first auth here. Run `yaffle cloud login` any time to save this setup to your account.",
    );
}

fn local_backend_access_note() -> &'static str {
    if local_first_feature_token_configured() {
        "this shell can reach the local Yaffle backend."
    } else {
        "set `YAFFLE_LOCAL_FIRST_FEATURE_TOKEN` in this shell to use the local Yaffle backend."
    }
}

fn describe_identity(principal: &yaffle_engine::StoredPrincipalCredential) -> String {
    match (
        principal.user_name.as_deref(),
        principal.user_email.as_deref(),
    ) {
        (Some(name), Some(email)) => format!("{name} <{email}>"),
        (Some(name), None) => name.to_string(),
        (None, Some(email)) => email.to_string(),
        (None, None) => principal.principal_id.clone(),
    }
}

fn bind_cloud_login_listener() -> io::Result<TcpListener> {
    for port in 10000..=10010 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok(listener);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "no localhost callback ports were available in the 10000-10010 range",
    ))
}

fn generate_pkce_verifier() -> io::Result<String> {
    let mut bytes = [0_u8; 48];
    getrandom::fill(&mut bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge_for_verifier(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn open_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").arg(url).status().is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .status()
            .is_ok();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return Command::new("xdg-open").arg(url).status().is_ok();
    }
    #[allow(unreachable_code)]
    false
}

struct CloudLoginCallback {
    code: String,
}

fn wait_for_cloud_login_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<CloudLoginCallback, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure cloud login listener: {error}"))?;
    let deadline = Instant::now() + CLOUD_LOGIN_TIMEOUT;

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0_u8; 8192];
                let bytes_read = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("failed to read cloud login callback: {error}"))?;
                let request = String::from_utf8_lossy(&buffer[..bytes_read]);
                let request_line = request
                    .lines()
                    .next()
                    .ok_or_else(|| "cloud login callback was empty".to_string())?;
                let mut parts = request_line.split_whitespace();
                let _method = parts.next();
                let target = parts.next().ok_or_else(|| {
                    "cloud login callback did not include a request target".to_string()
                })?;
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                if path != "/callback" {
                    write_login_callback_response(
                        &mut stream,
                        404,
                        "Yaffle Cloud login failed",
                        "Unexpected callback path.",
                    )
                    .ok();
                    return Err(format!("unexpected cloud login callback path: {path}"));
                }

                let mut code = None;
                let mut state = None;
                for pair in query.split('&') {
                    let mut pieces = pair.splitn(2, '=');
                    let key = pieces.next().unwrap_or("");
                    let value = pieces.next().unwrap_or("");
                    if key == "code" {
                        code = Some(value.to_string());
                    } else if key == "state" {
                        state = Some(value.to_string());
                    }
                }

                if state.as_deref() != Some(expected_state) {
                    write_login_callback_response(
                        &mut stream,
                        400,
                        "Yaffle Cloud login failed",
                        "State verification failed.",
                    )
                    .ok();
                    return Err("cloud login state verification failed".to_string());
                }

                let Some(code) = code else {
                    write_login_callback_response(
                        &mut stream,
                        400,
                        "Yaffle Cloud login failed",
                        "Authorization code was missing.",
                    )
                    .ok();
                    return Err(
                        "cloud login callback did not include an authorization code".to_string()
                    );
                };

                write_login_callback_response(
                    &mut stream,
                    200,
                    "Yaffle Cloud login complete",
                    "You can return to your terminal.",
                )
                .ok();
                return Ok(CloudLoginCallback { code });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for the cloud login callback".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(format!("failed to accept cloud login callback: {error}"));
            }
        }
    }
}

fn write_login_callback_response(
    stream: &mut std::net::TcpStream,
    status: u16,
    title: &str,
    message: &str,
) -> io::Result<()> {
    let body = format!(
        "<!DOCTYPE html><html><head><title>{title}</title><meta charset=\"utf-8\"></head><body style=\"font-family:system-ui;padding:32px;background:#09090b;color:#fafafa\"><h1 style=\"font-size:1rem\">{title}</h1><p style=\"color:#a1a1aa\">{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())
}

fn print_placeholder(command: &str, summary: &str, json: bool) -> CliResult {
    if json {
        let value = serde_json::json!({
            "contract_version": CONTRACT_VERSION,
            "command": command,
            "result": {
                "kind": "partial",
                "summary": summary,
            },
            "diagnostics": [{
                "level": "warning",
                "code": "not_implemented",
                "message": "This CLI alpha command is not fully implemented yet.",
            }],
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|error| {
                command_error(
                    json,
                    None,
                    None,
                    None,
                    "serialization_failed",
                    error.to_string(),
                )
            })?
        );
        return Ok(());
    }

    println!("{summary}");
    Ok(())
}

fn render_response(json: bool, response: &EngineResponse) -> CliResult {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(response).map_err(|error| {
                command_error(
                    json,
                    Some(response.operation.clone()),
                    response.target.clone(),
                    Some(response.selection.clone()),
                    "serialization_failed",
                    error.to_string(),
                )
            })?
        );
        return Ok(());
    }

    println!("{}", response.result.summary);
    Ok(())
}

#[allow(dead_code)]
fn command_help_for_tests() -> clap::Command {
    Cli::command()
}

fn command_error(
    json: bool,
    operation: Option<EngineOperation>,
    target: Option<EnvironmentTarget>,
    selection: Option<WorkspaceSelection>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> CliFailure {
    CliFailure {
        json,
        payload: EngineError {
            contract_version: CONTRACT_VERSION,
            operation,
            target,
            selection,
            error: ErrorPayload {
                code: code.into(),
                message: message.into(),
                details: None,
            },
        },
    }
}

fn current_working_directory(json: bool, request: &EngineRequest) -> Result<PathBuf, CliFailure> {
    std::env::current_dir().map_err(|error| {
        command_error(
            json,
            Some(request.operation.clone()),
            request.target.clone(),
            Some(request.selection.clone()),
            "current_directory_unavailable",
            format!("Failed to resolve the current working directory: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_status(
        principal: Option<yaffle_engine::StoredPrincipalCredential>,
        expired: bool,
    ) -> LocalCloudAuthStatus {
        LocalCloudAuthStatus {
            auth_store_path: PathBuf::from("/tmp/principal.json"),
            stored_principal: principal,
            expired,
        }
    }

    fn guest_principal() -> yaffle_engine::StoredPrincipalCredential {
        yaffle_engine::StoredPrincipalCredential {
            principal_type: StoredPrincipalType::AnonymousSession,
            principal_id: "guest-principal-id".to_string(),
            session_id: Some("guest-session-id".to_string()),
            token: "guest-token".to_string(),
            issued_at: "2026-05-03T00:00:00Z".to_string(),
            expires_at: Some("2026-05-17T00:00:00Z".to_string()),
            user_id: None,
            user_email: None,
            user_name: None,
        }
    }

    fn account_principal() -> yaffle_engine::StoredPrincipalCredential {
        yaffle_engine::StoredPrincipalCredential {
            principal_type: StoredPrincipalType::Account,
            principal_id: "account-principal-id".to_string(),
            session_id: None,
            token: "account-token".to_string(),
            issued_at: "2026-05-03T00:00:00Z".to_string(),
            expires_at: Some("2026-06-03T00:00:00Z".to_string()),
            user_id: Some("user-id".to_string()),
            user_email: Some("alex@example.com".to_string()),
            user_name: Some("Alex".to_string()),
        }
    }

    #[test]
    fn cloud_status_not_connected_uses_product_language() {
        let rendered = render_cloud_status_with_note(
            &test_status(None, false),
            "this shell can reach the local Yaffle backend.",
        );

        assert!(rendered.starts_with("Yaffle Cloud: not connected"));
        assert!(rendered.contains("run `yaffle converge` to continue as a temporary guest"));
        assert!(rendered.contains("run `yaffle cloud login` to connect your account"));
        assert!(!rendered.contains("principal.json"));
    }

    #[test]
    fn cloud_status_guest_prioritizes_user_state_over_internal_ids() {
        let rendered = render_cloud_status_with_note(
            &test_status(Some(guest_principal()), false),
            "this shell can reach the local Yaffle backend.",
        );

        assert!(rendered.starts_with("Yaffle Cloud: connected as a temporary guest"));
        assert!(rendered.contains("run `yaffle cloud login` to save this setup to your account"));
        assert!(!rendered.contains("guest-principal-id"));
        assert!(!rendered.contains("guest-session-id"));
        assert!(!rendered.contains("principal.json"));
    }

    #[test]
    fn cloud_status_account_leads_with_identity() {
        let rendered = render_cloud_status_with_note(
            &test_status(Some(account_principal()), false),
            "this shell can reach the local Yaffle backend.",
        );

        assert!(rendered.starts_with("Yaffle Cloud: connected as Alex <alex@example.com>"));
        assert!(rendered.contains("This machine is signed in to Yaffle Cloud"));
        assert!(rendered.contains("Session expires: 2026-06-03T00:00:00Z"));
        assert!(!rendered.contains("account-principal-id"));
    }

    #[test]
    fn cloud_login_success_conversion_feels_like_an_upgrade() {
        let rendered = render_cloud_login_success(&CloudCliLoginResult {
            principal: account_principal(),
            converted_from_anonymous: true,
        });

        assert!(rendered.contains("Logged into Yaffle Cloud as Alex <alex@example.com>."));
        assert!(rendered.contains("upgraded to your account"));
    }

    #[test]
    fn cloud_transition_ends_in_the_status_view() {
        let status = test_status(Some(account_principal()), false);
        let rendered = render_cloud_transition("Connected successfully.", &status);

        assert!(rendered.starts_with(
            "Connected successfully.\n\nYaffle Cloud: connected as Alex <alex@example.com>"
        ));
        assert!(rendered.contains("This machine is signed in to Yaffle Cloud"));
    }

    #[test]
    fn converge_tui_state_tracks_workspace_phases() {
        let mut state = ConvergeTuiState::new("main".to_string());
        state.apply_progress(EngineProgressEvent::ConvergePlan {
            environment_name: "main".to_string(),
            workspaces: vec!["infra/shared".to_string(), "apps/web/infra".to_string()],
            dag: "infra/shared──▶apps/web/infra".to_string(),
        });
        state.apply_progress(EngineProgressEvent::WorkspacePhase {
            workspace_path: "infra/shared".to_string(),
            phase: ConvergeWorkspacePhase::ApplyingTofu,
        });
        state.apply_progress(EngineProgressEvent::WorkspacePhase {
            workspace_path: "infra/shared".to_string(),
            phase: ConvergeWorkspacePhase::Completed,
        });

        assert_eq!(state.workspaces.len(), 2);
        assert_eq!(state.workspaces[0].state, WorkspaceRunState::Succeeded);
        assert_eq!(state.workspaces[1].state, WorkspaceRunState::Pending);
        assert!(state.summary.contains("Workspace ready"));
    }

    #[test]
    fn converge_tui_state_marks_failure_on_running_workspace() {
        let mut state = ConvergeTuiState::new("main".to_string());
        state.apply_progress(EngineProgressEvent::ConvergePlan {
            environment_name: "main".to_string(),
            workspaces: vec!["infra/shared".to_string()],
            dag: "infra/shared".to_string(),
        });
        state.apply_progress(EngineProgressEvent::WorkspacePhase {
            workspace_path: "infra/shared".to_string(),
            phase: ConvergeWorkspacePhase::InitializingTofu,
        });
        state.mark_finished_failure("tofu init failed");

        assert_eq!(state.workspaces[0].state, WorkspaceRunState::Failed);
        assert_eq!(state.failure_message.as_deref(), Some("tofu init failed"));
    }

    #[test]
    fn opentui_key_events_preserve_existing_navigation_bindings() {
        assert_eq!(
            OpenTuiKeyEvent {
                name: "down".to_string(),
                ctrl: false,
            }
            .to_tui_key(),
            Some(TuiKey::Down)
        );
        assert_eq!(
            OpenTuiKeyEvent {
                name: "j".to_string(),
                ctrl: false,
            }
            .to_tui_key(),
            Some(TuiKey::Char('j'))
        );
        assert_eq!(
            OpenTuiKeyEvent {
                name: "space".to_string(),
                ctrl: false,
            }
            .to_tui_key(),
            Some(TuiKey::Space)
        );
        assert_eq!(
            OpenTuiKeyEvent {
                name: "c".to_string(),
                ctrl: true,
            }
            .to_tui_key(),
            Some(TuiKey::Char('q'))
        );
    }

    #[test]
    fn opentui_detail_tabs_preserve_existing_order() {
        let tabs = render_detail_tabs(DetailTab::Outputs);
        let labels = tabs.iter().map(|tab| tab.label).collect::<Vec<_>>();

        assert_eq!(
            labels,
            vec![
                "Overview",
                "Plan",
                "Apply",
                "Outputs",
                "Activation",
                "Verification",
                "Runs",
            ]
        );
        assert_eq!(tabs.iter().filter(|tab| tab.selected).count(), 1);
        assert!(tabs.iter().any(|tab| tab.id == "outputs" && tab.selected));
    }

    #[test]
    fn tui_capability_modes_keep_execution_location_separate_from_environment_kind() {
        assert_eq!(
            TuiCapabilityMode::AnonymousLocal.as_snapshot_value(),
            "anonymousLocal"
        );
        assert_eq!(
            TuiCapabilityMode::AccountLocal.as_snapshot_value(),
            "accountLocal"
        );
        assert_eq!(
            TuiCapabilityMode::AccountRemote.as_snapshot_value(),
            "accountRemote"
        );
        assert_eq!(
            TuiCapabilityMode::AnonymousLocal
                .execution_location()
                .as_snapshot_value(),
            "local"
        );
        assert_eq!(
            TuiCapabilityMode::AccountLocal
                .execution_location()
                .as_snapshot_value(),
            "local"
        );
        assert_eq!(
            TuiCapabilityMode::AccountRemote
                .execution_location()
                .as_snapshot_value(),
            "remote"
        );
    }

    #[test]
    fn parses_github_repo_full_names_from_common_origin_urls() {
        assert_eq!(
            parse_github_repo_full_name("git@github.com:yaffledev/yaffle.git"),
            Some("yaffledev/yaffle".to_string())
        );
        assert_eq!(
            parse_github_repo_full_name("https://github.com/yaffledev/yaffle.git"),
            Some("yaffledev/yaffle".to_string())
        );
        assert_eq!(
            parse_github_repo_full_name("https://example.com/repo.git"),
            None
        );
    }

    #[test]
    fn cloud_inventory_entries_include_named_and_transient_environments() {
        let inventory = CloudCliInventory {
            repo_full_name: "yaffledev/yaffle".to_string(),
            environments: vec![
                yaffle_engine::CloudCliInventoryEnvironment {
                    repo: "yaffle".to_string(),
                    environment_kind: "transient".to_string(),
                    environment_name: "pr-42".to_string(),
                    source_kind: Some("github_pull_request".to_string()),
                    status: "ready".to_string(),
                    git_ref: "refs/heads/feature/test".to_string(),
                    head_sha: "abcdef1234567890".to_string(),
                    updated_at: "2026-05-24T00:00:00Z".to_string(),
                    workspace_count: 3,
                    status_vector: vec![
                        yaffle_engine::CloudCliInventoryStatusCount {
                            status: "ready".to_string(),
                            count: 2,
                        },
                        yaffle_engine::CloudCliInventoryStatusCount {
                            status: "planning".to_string(),
                            count: 1,
                        },
                    ],
                    pr_number: Some(42),
                    actor_login: Some("alex".to_string()),
                },
                yaffle_engine::CloudCliInventoryEnvironment {
                    repo: "yaffle".to_string(),
                    environment_kind: "named".to_string(),
                    environment_name: "main".to_string(),
                    source_kind: None,
                    status: "ready".to_string(),
                    git_ref: "refs/heads/main".to_string(),
                    head_sha: "1234567890abcdef".to_string(),
                    updated_at: "2026-05-24T00:00:00Z".to_string(),
                    workspace_count: 2,
                    status_vector: vec![yaffle_engine::CloudCliInventoryStatusCount {
                        status: "ready".to_string(),
                        count: 2,
                    }],
                    pr_number: None,
                    actor_login: None,
                },
            ],
        };

        let entries =
            cloud_inventory_to_environment_entries(Path::new("/tmp/yaffle-no-state"), &inventory);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "main");
        assert_eq!(entries[0].kind, "named");
        assert_eq!(entries[0].workspace_count, 2);
        assert_eq!(entries[0].origin.as_deref(), Some("branch main"));
        assert_eq!(entries[0].head_sha.as_deref(), Some("1234567890abcdef"));
        assert_eq!(entries[1].name, "pr-42");
        assert_eq!(entries[1].kind, "transient");
        assert_eq!(entries[1].workspace_count, 3);
        assert_eq!(entries[1].origin.as_deref(), Some("PR #42"));
        assert_eq!(entries[1].actor.as_deref(), Some("alex"));
        assert_eq!(
            entries[1].status_vector,
            vec![
                EnvironmentStatusCount {
                    status: "ready".to_string(),
                    count: 2,
                },
                EnvironmentStatusCount {
                    status: "planning".to_string(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn maps_origin_remote_refs_to_head_refs_for_remote_converge() {
        assert_eq!(
            map_origin_remote_ref_to_head_ref("refs/remotes/origin/main"),
            Some("refs/heads/main".to_string())
        );
        assert_eq!(
            map_origin_remote_ref_to_head_ref("refs/remotes/origin/feature/remote"),
            Some("refs/heads/feature/remote".to_string())
        );
        assert_eq!(
            map_origin_remote_ref_to_head_ref("refs/remotes/origin/HEAD"),
            None
        );
    }

    #[test]
    fn parses_remote_ref_lines_from_git_for_each_ref_output() {
        assert_eq!(
            parse_git_remote_ref_line(
                "refs/remotes/origin/main abcdef1234567890abcdef1234567890abcdef12"
            ),
            Some((
                "refs/remotes/origin/main".to_string(),
                "abcdef1234567890abcdef1234567890abcdef12".to_string(),
            ))
        );
        assert_eq!(parse_git_remote_ref_line(""), None);
        assert_eq!(parse_git_remote_ref_line("refs/remotes/origin/main"), None);
    }
}
