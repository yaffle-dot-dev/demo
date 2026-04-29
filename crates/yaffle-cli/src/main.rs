use std::fmt::{Display, Formatter};
use std::io;
use std::path::PathBuf;

use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};

use yaffle_contracts::{
    EngineError, EngineOperation, EngineResponse, EnvironmentTarget, ErrorPayload,
    WorkspaceSelection, CONTRACT_VERSION,
};
use yaffle_engine::{
    clear_local_cloud_auth, execute, load_local_cloud_auth_status,
    local_first_feature_token_configured, prepare_tf_login_exports, EngineRequest,
    LocalCloudAuthStatus,
};

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
    after_help = "Examples:\n  yaffle init\n  yaffle converge --env main\n  yaffle outputs --env main --workspace apps/control-plane/infra\n  yaffle graph --env pr-7\n  eval \"$(yaffle tf login --env main --workspace apps/web/infra)\"\n  yaffle cloud login"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Initialize or scaffold repo-native Yaffle config
    Init,
    /// Converge an environment to the current desired configuration and revision
    Converge(TargetedCommand),
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
    /// Workspace path
    #[arg(long = "workspace")]
    workspace: String,
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
        Commands::Init => print_placeholder(
            "init",
            "Initialize or scaffold repo-native Yaffle config",
            false,
        ),
        Commands::Converge(command) => run_targeted_operation(EngineOperation::Converge, command),
        Commands::Destroy(command) => run_targeted_operation(EngineOperation::Destroy, command),
        Commands::Status(command) => run_environment_operation(EngineOperation::Status, command),
        Commands::Wait(command) => run_wait(command),
        Commands::Outputs(command) => run_outputs(command),
        Commands::Graph(command) => run_graph(command),
        Commands::Doctor => run_doctor(),
        Commands::Tf(command) => run_tf(command),
        Commands::Completion(command) => run_completion(command),
        Commands::Cloud(command) => run_cloud(command),
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
                workspaces: vec![command.workspace],
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

    print!("{exports}");
    Ok(())
}

fn run_cloud(command: CloudCommands) -> CliResult {
    match command {
        CloudCommands::Login => print_placeholder(
            "cloud",
            "Account-backed `yaffle cloud login` is not implemented yet. For local-first work, Yaffle bootstraps a machine-local guest session automatically on first `yaffle converge` or `yaffle tf login`.",
            false,
        ),
        CloudCommands::Logout => run_cloud_logout(),
        CloudCommands::Status => run_cloud_status(),
    }
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

    if removed {
        println!(
            "Removed local Yaffle Cloud auth at {}. Any guest-owned hosted output modules stay tied to that deleted machine-local session.",
            status.auth_store_path.display()
        );
    } else {
        println!(
            "No local Yaffle Cloud auth state found at {}.",
            status.auth_store_path.display()
        );
    }

    Ok(())
}

fn render_cloud_status(status: &LocalCloudAuthStatus) -> String {
    let feature_token_note = if local_first_feature_token_configured() {
        "Local-first guest bootstrap is enabled in this shell."
    } else {
        "Local-first guest bootstrap is unavailable in this shell until `YAFFLE_LOCAL_FIRST_FEATURE_TOKEN` is set."
    };

    let Some(principal) = &status.stored_principal else {
        return format!(
            "Yaffle Cloud status: no local auth state\nStore: {}\n{}\nA machine-local guest session will be created automatically on first `yaffle converge` or `yaffle tf login` once local-first access is enabled.",
            status.auth_store_path.display(),
            feature_token_note,
        );
    };

    let lifecycle = if status.expired { "expired" } else { "active" };
    let expires_at = principal.expires_at.as_deref().unwrap_or("unknown");

    format!(
        "Yaffle Cloud status: machine-local guest session ({lifecycle})\nPrincipal: {}\nSession: {}\nIssued: {}\nExpires: {}\nStore: {}\n{}\nGuest sessions stay on the machine where they were created. Deleting this file discards access to guest-owned hosted output modules. Account-backed login/upgrade is not implemented yet.",
        principal.principal_id,
        principal.session_id,
        principal.issued_at,
        expires_at,
        status.auth_store_path.display(),
        feature_token_note,
    )
}

fn run_completion(command: CompletionCommand) -> CliResult {
    let mut root = Cli::command();
    generate(command.shell, &mut root, "yaffle", &mut io::stdout());
    Ok(())
}

fn run_engine_request(json: bool, request: EngineRequest) -> CliResult {
    let working_dir = current_working_directory(json, &request)?;
    let response =
        execute(&request, &working_dir).map_err(|payload| CliFailure { json, payload })?;

    render_response(json, &response)
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
