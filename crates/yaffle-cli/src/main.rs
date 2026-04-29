use std::fmt::{Display, Formatter};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use base64::Engine;
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};
use sha2::{Digest, Sha256};

use yaffle_contracts::{
    EngineError, EngineOperation, EngineResponse, EnvironmentTarget, ErrorPayload,
    WorkspaceSelection, CONTRACT_VERSION,
};
use yaffle_engine::{
    build_cloud_cli_authorize_url, clear_local_cloud_auth, exchange_cloud_cli_login_code, execute,
    load_local_cloud_auth_status, local_first_feature_token_configured, prepare_tf_login_exports,
    CloudCliLoginResult, EngineRequest, LocalCloudAuthStatus, StoredPrincipalType,
};

const CLOUD_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

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
    after_help = "Examples:\n  yaffle init\n  yaffle converge --env main\n  yaffle outputs --env main\n  yaffle outputs --env main --workspace apps/control-plane/infra\n  yaffle graph --env pr-7\n  eval \"$(yaffle tf login --env main --workspace apps/web/infra)\"\n  yaffle cloud login"
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
}
