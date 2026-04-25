use anyhow::{anyhow, Result};
use clap::{Args, CommandFactory, Parser, Subcommand};

use yaffle_config::validate_environment_name;
use yaffle_contracts::{ContractVersion, EnvironmentTarget, WorkspaceSelection};
use yaffle_engine::{placeholder_response, EngineOperation, EngineRequest};

#[derive(Debug, Parser)]
#[command(name = "yaffle", version, about = "Yaffle CLI")]
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
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init => print_placeholder("init", "Initialize or scaffold repo-native Yaffle config", false),
        Commands::Converge(command) => run_targeted_operation(EngineOperation::Converge, command),
        Commands::Destroy(command) => run_targeted_operation(EngineOperation::Destroy, command),
        Commands::Status(command) => run_environment_operation(EngineOperation::Status, command),
        Commands::Wait(command) => run_wait(command),
        Commands::Outputs(command) => run_outputs(command),
        Commands::Graph(command) => run_graph(command),
        Commands::Doctor => print_placeholder("doctor", "Diagnose local or cloud prerequisites, configuration, and capability problems", false),
        Commands::Cloud(command) => run_cloud(command),
    }
}

fn run_targeted_operation(operation: EngineOperation, command: TargetedCommand) -> Result<()> {
    validate_environment_name(&command.env)?;

    let request = EngineRequest {
        contract_version: ContractVersion::default(),
        operation,
        target: Some(EnvironmentTarget {
            environment: command.env,
        }),
        selection: WorkspaceSelection {
            workspaces: command.workspaces,
        },
    };

    let response = placeholder_response(
        &request,
        "CLI alpha placeholder: Rust shell is wired, engine execution is not implemented yet.",
    );
    render_response(command.json, &response)
}

fn run_environment_operation(operation: EngineOperation, command: EnvironmentOnlyCommand) -> Result<()> {
    validate_environment_name(&command.env)?;

    let request = EngineRequest {
        contract_version: ContractVersion::default(),
        operation,
        target: Some(EnvironmentTarget {
            environment: command.env,
        }),
        selection: WorkspaceSelection::default(),
    };

    let response = placeholder_response(
        &request,
        "CLI alpha placeholder: Rust shell is wired, engine execution is not implemented yet.",
    );
    render_response(command.json, &response)
}

fn run_wait(command: WaitCommand) -> Result<()> {
    validate_environment_name(&command.env)?;
    if command.condition.trim().is_empty() {
        return Err(anyhow!("condition passed to --for must not be empty"));
    }

    let request = EngineRequest {
        contract_version: ContractVersion::default(),
        operation: EngineOperation::Status,
        target: Some(EnvironmentTarget {
            environment: command.env,
        }),
        selection: WorkspaceSelection::default(),
    };

    let response = placeholder_response(
        &request,
        format!(
            "CLI alpha placeholder: waiting for condition '{}' is not implemented yet.",
            command.condition
        ),
    );
    render_response(command.json, &response)
}

fn run_outputs(command: OutputsCommand) -> Result<()> {
    validate_environment_name(&command.env)?;
    if command.workspace.trim().is_empty() {
        return Err(anyhow!("workspace passed to --workspace must not be empty"));
    }

    let request = EngineRequest {
        contract_version: ContractVersion::default(),
        operation: EngineOperation::Outputs,
        target: Some(EnvironmentTarget {
            environment: command.env,
        }),
        selection: WorkspaceSelection {
            workspaces: vec![command.workspace],
        },
    };

    let response = placeholder_response(
        &request,
        "CLI alpha placeholder: outputs execution is not implemented in Rust yet.",
    );
    render_response(command.json, &response)
}

fn run_graph(command: GraphCommand) -> Result<()> {
    if let Some(environment) = &command.env {
        validate_environment_name(environment)?;
    }

    let request = EngineRequest {
        contract_version: ContractVersion::default(),
        operation: EngineOperation::Graph,
        target: command.env.map(|environment| EnvironmentTarget { environment }),
        selection: WorkspaceSelection::default(),
    };

    let response = placeholder_response(
        &request,
        "CLI alpha placeholder: graph execution is not implemented in Rust yet.",
    );
    render_response(command.json, &response)
}

fn run_cloud(command: CloudCommands) -> Result<()> {
    let summary = match command {
        CloudCommands::Login => "CLI alpha placeholder: cloud login is not implemented in Rust yet.",
        CloudCommands::Logout => "CLI alpha placeholder: cloud logout is not implemented in Rust yet.",
        CloudCommands::Status => "CLI alpha placeholder: cloud status is not implemented in Rust yet.",
    };

    print_placeholder("cloud", summary, false)
}

fn print_placeholder(command: &str, summary: &str, json: bool) -> Result<()> {
    if json {
        let value = serde_json::json!({
            "command": command,
            "summary": summary,
            "status": "not_implemented",
        });
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }

    println!("{summary}");
    Ok(())
}

fn render_response(json: bool, response: &yaffle_engine::EngineResponse) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(response)?);
        return Ok(());
    }

    println!("{}", response.summary);
    Ok(())
}

#[allow(dead_code)]
fn command_help_for_tests() -> clap::Command {
    Cli::command()
}
