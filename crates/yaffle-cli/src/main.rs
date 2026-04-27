use std::fmt::{Display, Formatter};
use std::io;
use std::path::PathBuf;

use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};

use yaffle_contracts::{
    EngineError, EngineOperation, EngineResponse, EnvironmentTarget, ErrorPayload,
    WorkspaceSelection, CONTRACT_VERSION,
};
use yaffle_engine::{execute, EngineRequest};

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
    after_help = "Examples:\n  yaffle init\n  yaffle converge --env main\n  yaffle outputs --env main --workspace apps/control-plane/infra\n  yaffle graph --env pr-7\n  yaffle cloud login"
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

fn run_cloud(command: CloudCommands) -> CliResult {
    let summary = match command {
        CloudCommands::Login => {
            "CLI alpha placeholder: cloud login is not implemented in Rust yet."
        }
        CloudCommands::Logout => {
            "CLI alpha placeholder: cloud logout is not implemented in Rust yet."
        }
        CloudCommands::Status => {
            "CLI alpha placeholder: cloud status is not implemented in Rust yet."
        }
    };

    print_placeholder("cloud", summary, false)
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
