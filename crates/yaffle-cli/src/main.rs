use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::io::{self, IsTerminal, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::{generate, Shell};
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use crossterm::{execute as crossterm_execute, terminal};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Terminal;
use sha2::{Digest, Sha256};

use yaffle_contracts::{
    EngineError, EngineOperation, EngineResponse, EnvironmentTarget, ErrorPayload, TerraformOutput,
    WorkspaceSelection, CONTRACT_VERSION,
};
use yaffle_engine::{
    build_cloud_cli_authorize_url, clear_local_cloud_auth, exchange_cloud_cli_login_code, execute,
    execute_with_progress, load_local_cloud_auth_status, local_first_feature_token_configured,
    prepare_tf_login_exports, CloudCliLoginResult, ConvergeWorkspacePhase, EngineProgressEvent,
    EngineRequest, LocalCloudAuthStatus, StoredPrincipalType, TofuLogStream,
};
use yaffle_graph::{
    environment_kind_for_name, resolve_workspace_graph, EnvironmentKind, ResolvedWorkspaceGraph,
    WorkspaceGraphOptions,
};

const CLOUD_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const YAFFLE_SURFACE: Color = Color::Rgb(12, 12, 11);
const YAFFLE_SURFACE_RAISED: Color = Color::Rgb(24, 24, 26);
const YAFFLE_BORDER: Color = Color::Rgb(61, 61, 50);
const YAFFLE_BORDER_ACCENT: Color = Color::Rgb(78, 95, 41);
const YAFFLE_TEXT: Color = Color::Rgb(250, 250, 248);
const YAFFLE_TEXT_MUTED: Color = Color::Rgb(181, 181, 168);
const YAFFLE_GREEN: Color = Color::Rgb(139, 196, 49);
const YAFFLE_GREEN_SOFT: Color = Color::Rgb(109, 163, 35);
const YAFFLE_CREAM: Color = Color::Rgb(252, 224, 71);
const YAFFLE_RED: Color = Color::Rgb(250, 45, 45);

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

    if command.json || command.plain || !should_use_converge_tui() {
        return run_engine_request(command.json, request);
    }

    run_shell_with_startup(Some(request))
}

fn should_use_converge_tui() -> bool {
    io::stdout().is_terminal() && io::stderr().is_terminal()
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

    enable_raw_mode().map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_init_failed",
            format!("Failed to enable terminal raw mode: {error}"),
        )
    })?;

    let mut stdout = io::stdout();
    crossterm_execute!(
        stdout,
        terminal::EnterAlternateScreen,
        crossterm::cursor::Hide
    )
    .map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_init_failed",
            format!("Failed to enter the Yaffle terminal app: {error}"),
        )
    })?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).map_err(|error| {
        command_error(
            false,
            None,
            None,
            None,
            "tui_init_failed",
            format!("Failed to create the Yaffle terminal app: {error}"),
        )
    })?;

    let loop_result = run_shell_loop(&mut terminal, &mut app);

    let _ = disable_raw_mode();
    let _ = crossterm_execute!(
        terminal.backend_mut(),
        terminal::LeaveAlternateScreen,
        crossterm::cursor::Show
    );
    let _ = terminal.show_cursor();

    match loop_result? {
        ShellAction::Quit => Ok(()),
    }
}

fn run_shell_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut LocalAppState,
) -> Result<ShellAction, CliFailure> {
    loop {
        terminal
            .draw(|frame| render_shell_app(frame, app))
            .map_err(|error| {
                command_error(
                    false,
                    None,
                    None,
                    None,
                    "tui_render_failed",
                    format!("Failed to render the Yaffle terminal app: {error}"),
                )
            })?;

        if event::poll(Duration::from_millis(120)).map_err(|error| {
            command_error(
                false,
                None,
                None,
                None,
                "tui_event_failed",
                format!("Failed to poll terminal events: {error}"),
            )
        })? {
            if let Event::Key(key_event) = event::read().map_err(|error| {
                command_error(
                    false,
                    None,
                    None,
                    None,
                    "tui_event_failed",
                    format!("Failed to read terminal events: {error}"),
                )
            })? {
                if let Some(action) = app.handle_key(key_event.code)? {
                    return Ok(action);
                }
            }
        }

        app.tick();
    }
}

#[derive(Debug)]
enum ConvergeTuiEvent {
    Progress(EngineProgressEvent),
    Finished(Result<EngineResponse, EngineError>),
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

#[derive(Debug, Clone)]
struct DagCell {
    ch: char,
    style: Style,
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

    fn mark_finished_success(&mut self, summary: &str) {
        self.summary = "Converge complete".to_string();
        self.detail = summary.to_string();
    }

    fn mark_finished_failure(&mut self, message: &str) {
        self.summary = "Converge failed".to_string();
        self.detail = "Yaffle stopped before the environment finished converging.".to_string();
        self.failure_message = Some(message.to_string());

        if let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.state == WorkspaceRunState::Running)
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

fn render_workspace_log_line(log: &WorkspaceLogLine) -> Line<'static> {
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

#[derive(Debug)]
enum ShellAction {
    Quit,
}

#[derive(Debug)]
struct ActiveConvergeRun {
    progress: ConvergeTuiState,
    rx: mpsc::Receiver<ConvergeTuiEvent>,
    running: bool,
    last_response: Option<EngineResponse>,
    last_error: Option<EngineError>,
}

#[derive(Debug, Clone)]
struct LocalEnvironmentEntry {
    name: String,
    kind: String,
    workspace_count: usize,
    local_state_detected: bool,
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
    Plan,
    Apply,
    Outputs,
}

#[derive(Debug)]
struct LocalEnvironmentDetailState {
    environment_name: String,
    graph: ResolvedWorkspaceGraph,
    levels: Vec<Vec<String>>,
    selected_level: usize,
    selected_row: usize,
    selected_workspaces: std::collections::BTreeSet<String>,
    focus: ShellFocus,
    tab: DetailTab,
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

#[derive(Debug)]
struct LocalAppState {
    repo_root: PathBuf,
    config: yaffle_config::YaffleConfig,
    environments: Vec<LocalEnvironmentEntry>,
    selected_env_index: usize,
    view: ShellView,
    detail: Option<LocalEnvironmentDetailState>,
    footer_message: String,
}

impl LocalAppState {
    fn load(working_dir: &Path) -> Result<Self, CliFailure> {
        let (repo_root, config) = load_local_config_context(working_dir)?;
        let environments = discover_local_environments(&repo_root, &config);

        Ok(Self {
            repo_root,
            config,
            environments,
            selected_env_index: 0,
            view: ShellView::EnvironmentList,
            detail: None,
            footer_message: "Enter opens an environment. q quits.".to_string(),
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
        self.footer_message =
            "tab switches panels • c converges selection • b goes back • q quits".to_string();
        Ok(())
    }

    fn start_converge_in_place(&mut self, request: EngineRequest) -> Result<(), CliFailure> {
        let prior_cloud_auth_status = load_local_cloud_auth_status().ok();
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

        let prior_cloud_auth_status = prior_cloud_auth_status;
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
            progress,
            rx,
            running: true,
            last_response: None,
            last_error: None,
        });
        detail.status_response = None;
        detail.status_error = None;
        detail.status_loading = false;
        detail.status_rx = None;
        detail.outputs_response = None;
        detail.outputs_error = None;
        detail.outputs_loading = false;
        detail.outputs_rx = None;
        maybe_print_guest_bootstrap_notice(prior_cloud_auth_status.as_ref());
        Ok(())
    }

    fn handle_key(&mut self, key: KeyCode) -> Result<Option<ShellAction>, CliFailure> {
        match self.view {
            ShellView::EnvironmentList => self.handle_environment_list_key(key),
            ShellView::EnvironmentDetail => self.handle_environment_detail_key(key),
        }
    }

    fn handle_environment_list_key(
        &mut self,
        key: KeyCode,
    ) -> Result<Option<ShellAction>, CliFailure> {
        match key {
            KeyCode::Char('q') => return Ok(Some(ShellAction::Quit)),
            KeyCode::Down | KeyCode::Char('j') => {
                if !self.environments.is_empty() {
                    self.selected_env_index =
                        (self.selected_env_index + 1) % self.environments.len();
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if !self.environments.is_empty() {
                    self.selected_env_index = if self.selected_env_index == 0 {
                        self.environments.len() - 1
                    } else {
                        self.selected_env_index - 1
                    };
                }
            }
            KeyCode::Enter => {
                if let Some(entry) = self.environments.get(self.selected_env_index) {
                    let detail =
                        load_environment_detail(&self.repo_root, &self.config, &entry.name)?;
                    self.detail = Some(detail);
                    self.view = ShellView::EnvironmentDetail;
                    self.footer_message =
                        "tab switches panels • c converges selection • b goes back • q quits"
                            .to_string();
                }
            }
            _ => {}
        }

        Ok(None)
    }

    fn handle_environment_detail_key(
        &mut self,
        key: KeyCode,
    ) -> Result<Option<ShellAction>, CliFailure> {
        let Some(detail) = self.detail.as_mut() else {
            self.view = ShellView::EnvironmentList;
            return Ok(None);
        };

        match key {
            KeyCode::Char('q') => return Ok(Some(ShellAction::Quit)),
            KeyCode::Char('b') | KeyCode::Esc => {
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
                self.footer_message = "Enter opens an environment. q quits.".to_string();
            }
            KeyCode::Tab => {
                detail.focus = match detail.focus {
                    ShellFocus::Graph => ShellFocus::Detail,
                    ShellFocus::Detail => ShellFocus::Graph,
                };
            }
            KeyCode::Char('f') => {
                detail.follow_running_workspace = true;
            }
            KeyCode::Char('c') => {
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

        if !self
            .active_run
            .as_ref()
            .map(|run| run.running)
            .unwrap_or(false)
        {
            match self.tab {
                DetailTab::Apply => self.load_selected_tab_if_needed(repo_root),
                DetailTab::Outputs => self.load_selected_tab_if_needed(repo_root),
                DetailTab::Plan => {}
            }
        }
    }

    fn selected_workspace(&self) -> Option<&str> {
        self.levels
            .get(self.selected_level)
            .and_then(|level| level.get(self.selected_row))
            .map(|value| value.as_str())
    }

    fn select_workspace_by_path(&mut self, workspace_path: &str) {
        if let Some((level_index, row_index)) =
            self.levels
                .iter()
                .enumerate()
                .find_map(|(level_index, level)| {
                    level
                        .iter()
                        .position(|path| path == workspace_path)
                        .map(|row_index| (level_index, row_index))
                })
        {
            self.selected_level = level_index;
            self.selected_row = row_index;
        }
    }

    fn handle_graph_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Left | KeyCode::Char('h') => {
                if self.selected_level > 0 {
                    self.selected_level -= 1;
                    self.selected_row = self
                        .selected_row
                        .min(self.levels[self.selected_level].len().saturating_sub(1));
                }
            }
            KeyCode::Right | KeyCode::Char('l') => {
                if self.selected_level + 1 < self.levels.len() {
                    self.selected_level += 1;
                    self.selected_row = self
                        .selected_row
                        .min(self.levels[self.selected_level].len().saturating_sub(1));
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(level) = self.levels.get(self.selected_level) {
                    if !level.is_empty() {
                        self.selected_row = (self.selected_row + 1) % level.len();
                    }
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
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
            KeyCode::Char(' ') => {
                if self
                    .active_run
                    .as_ref()
                    .map(|run| run.running)
                    .unwrap_or(false)
                {
                    return;
                }
                if let Some(workspace) = self.selected_workspace().map(ToOwned::to_owned) {
                    if !self.selected_workspaces.insert(workspace.clone()) {
                        self.selected_workspaces.remove(&workspace);
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_detail_key(&mut self, key: KeyCode, repo_root: &Path) -> Result<(), CliFailure> {
        match key {
            KeyCode::Left | KeyCode::Char('h') => {
                self.tab = match self.tab {
                    DetailTab::Plan => DetailTab::Outputs,
                    DetailTab::Apply => DetailTab::Plan,
                    DetailTab::Outputs => DetailTab::Apply,
                };
                self.detail_scroll = 0;
                self.load_selected_tab_if_needed(repo_root);
            }
            KeyCode::Right | KeyCode::Char('l') => {
                self.tab = match self.tab {
                    DetailTab::Plan => DetailTab::Apply,
                    DetailTab::Apply => DetailTab::Outputs,
                    DetailTab::Outputs => DetailTab::Plan,
                };
                self.detail_scroll = 0;
                self.load_selected_tab_if_needed(repo_root);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.detail_scroll = self.detail_scroll.saturating_add(1);
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.detail_scroll = self.detail_scroll.saturating_sub(1);
            }
            KeyCode::Char('r') => {
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
            DetailTab::Plan => {}
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
        let Some(selected) = self.selected_workspace() else {
            return &[];
        };
        self.active_run
            .as_ref()
            .and_then(|run| run.progress.workspace_logs.get(selected))
            .map(Vec::as_slice)
            .unwrap_or(&[])
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
            DetailTab::Plan => Ok(()),
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

fn render_shell_app(frame: &mut ratatui::Frame, app: &LocalAppState) {
    match app.view {
        ShellView::EnvironmentList => render_environment_browser(frame, app),
        ShellView::EnvironmentDetail => render_environment_detail(frame, app),
    }
}

fn render_environment_browser(frame: &mut ratatui::Frame, app: &LocalAppState) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(8),
            Constraint::Length(3),
        ])
        .split(frame.area());

    let header = Paragraph::new(vec![
        Line::from(vec![Span::styled(
            "Yaffle",
            Style::default()
                .fg(YAFFLE_GREEN)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from("Choose an environment to inspect or converge."),
    ])
    .block(
        Block::default()
            .title(" Environments ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(YAFFLE_BORDER_ACCENT))
            .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT)),
    );
    frame.render_widget(header, areas[0]);

    let items = if app.environments.is_empty() {
        vec![ListItem::new("No local environments found.")]
    } else {
        app.environments
            .iter()
            .enumerate()
            .map(|(index, env)| {
                let marker = if index == app.selected_env_index {
                    "▶"
                } else {
                    " "
                };
                let state_badge = if env.local_state_detected {
                    "local state"
                } else {
                    "config only"
                };
                ListItem::new(Line::from(vec![
                    Span::styled(marker, Style::default().fg(YAFFLE_CREAM)),
                    Span::raw(" "),
                    Span::styled(
                        &env.name,
                        Style::default()
                            .fg(YAFFLE_TEXT)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(format!(
                        "  [{}]  {} workspace(s)  {}",
                        env.kind, env.workspace_count, state_badge
                    )),
                ]))
            })
            .collect()
    };

    let list = List::new(items).block(
        Block::default()
            .title(" Local + Known Environments ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(YAFFLE_BORDER_ACCENT))
            .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT)),
    );
    frame.render_widget(list, areas[1]);

    let footer = Paragraph::new("j/k move • enter open • q quit").block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(YAFFLE_BORDER))
            .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT_MUTED)),
    );
    frame.render_widget(footer, areas[2]);
}

fn render_environment_detail(frame: &mut ratatui::Frame, app: &LocalAppState) {
    let Some(detail) = app.detail.as_ref() else {
        render_environment_browser(frame, app);
        return;
    };

    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(14),
            Constraint::Min(12),
            Constraint::Length(3),
        ])
        .split(frame.area());

    let selected = detail.selected_workspace().unwrap_or("none");
    let running_summary = detail.running_summary();
    let header = Paragraph::new(vec![
        Line::from(vec![
            Span::styled(
                format!("Environment: {}", detail.environment_name),
                Style::default()
                    .fg(YAFFLE_GREEN)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!("   selected workspace: {selected}")),
        ]),
        Line::from(summarize_selected_workspaces(detail)),
        Line::from(match running_summary {
            Some((progress, true)) => format!(
                "Mode: running • {} • focus follows active workspace: {}",
                progress.summary,
                if detail.follow_running_workspace {
                    "on"
                } else {
                    "off"
                }
            ),
            Some((progress, false)) => format!("Mode: review • last run: {}", progress.summary),
            None => "Mode: review".to_string(),
        }),
    ])
    .block(
        Block::default()
            .title(" Environment View ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(YAFFLE_BORDER_ACCENT))
            .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT)),
    );
    frame.render_widget(header, areas[0]);

    let dag = Paragraph::new(render_environment_dag(detail))
        .block(
            Block::default()
                .title(" DAG ")
                .borders(Borders::ALL)
                .border_style(panel_border_style(detail.focus == ShellFocus::Graph))
                .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT)),
        )
        .wrap(Wrap { trim: false });
    frame.render_widget(dag, areas[1]);

    let detail_title = Line::from(vec![
        Span::styled(" Detail ", Style::default().fg(YAFFLE_TEXT_MUTED)),
        Span::raw(" "),
        render_detail_tab_chip("Plan", detail.tab == DetailTab::Plan),
        Span::raw(" "),
        render_detail_tab_chip("Apply", detail.tab == DetailTab::Apply),
        Span::raw(" "),
        render_detail_tab_chip("Outputs", detail.tab == DetailTab::Outputs),
    ]);
    let detail_panel = Paragraph::new(render_environment_detail_panel(detail))
        .block(
            Block::default()
                .title(detail_title)
                .borders(Borders::ALL)
                .border_style(panel_border_style(detail.focus == ShellFocus::Detail))
                .style(Style::default().bg(YAFFLE_SURFACE_RAISED).fg(YAFFLE_TEXT)),
        )
        .wrap(Wrap { trim: false })
        .scroll((detail.detail_scroll as u16, 0));
    frame.render_widget(detail_panel, areas[2]);

    let footer = Paragraph::new(match detail.focus {
        ShellFocus::Graph => {
            if detail.active_run.as_ref().map(|run| run.running).unwrap_or(false) {
                "graph focus • h/l move levels • j/k move nodes • space disabled while running • tab detail • b locked • q quit"
            } else {
                "graph focus • h/l move levels • j/k move nodes • space select • c converge • tab detail • b back • q quit"
            }
        }
        ShellFocus::Detail => {
            if detail.active_run.as_ref().map(|run| run.running).unwrap_or(false) {
                "detail focus • h/l switch tabs • j/k scroll • r reload data • tab graph • c disabled • b locked • q quit"
            } else {
                "detail focus • h/l switch tabs • j/k scroll • r reload data • tab graph • c converge • b back • q quit"
            }
        }
    })
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(YAFFLE_BORDER))
            .style(Style::default().bg(YAFFLE_SURFACE).fg(YAFFLE_TEXT_MUTED)),
    );
    frame.render_widget(footer, areas[3]);
}

fn render_environment_detail_panel(detail: &LocalEnvironmentDetailState) -> Vec<Line<'static>> {
    let selected = detail.selected_workspace().unwrap_or("none");
    match detail.tab {
        DetailTab::Plan => {
            let selection = summarize_selected_workspaces(detail);
            vec![
                Line::from(format!("Selected workspace: {selected}")),
                Line::from(""),
                Line::from(selection),
                Line::from(
                    "Press `c` to run converge. If nothing is selected, Yaffle converges the full environment.",
                ),
                Line::from("Use space in the DAG view to include or exclude a workspace."),
            ]
        }
        DetailTab::Apply => {
            let mut lines = vec![
                Line::from(format!("Selected workspace: {selected}")),
                Line::from(""),
            ];
            if let Some((progress, running)) = detail.running_summary() {
                let workspace_run_state = detail.active_run_status_for_workspace(selected);
                lines.push(Line::from(format!(
                    "Environment run: {}",
                    if running { "running" } else { "finished" }
                )));
                if let Some((workspace_state, workspace_phase)) = workspace_run_state {
                    lines.push(Line::from(format!(
                        "Workspace state: {}",
                        match workspace_state {
                            WorkspaceRunState::Pending => "waiting",
                            WorkspaceRunState::Running => "running",
                            WorkspaceRunState::Succeeded => "converged",
                            WorkspaceRunState::Failed => "failed",
                        }
                    )));
                    lines.push(Line::from(format!(
                        "Current phase: {}",
                        workspace_phase.map(phase_label).unwrap_or("not started")
                    )));
                }
                lines.push(Line::from(""));
                lines.push(Line::from(progress.detail.clone()));
                if !detail.selected_workspace_log_lines().is_empty() {
                    lines.push(Line::from(""));
                    lines.push(Line::from("Recent activity:"));
                    for log in detail
                        .selected_workspace_log_lines()
                        .iter()
                        .rev()
                        .take(8)
                        .rev()
                    {
                        lines.push(render_workspace_log_line(log));
                    }
                }
                return lines;
            }
            match (&detail.status_response, &detail.status_error) {
                (Some(status), _) => {
                    let snapshot = status
                        .workspaces
                        .iter()
                        .find(|workspace| workspace.workspace_path == selected);
                    lines.push(Line::from(format!(
                        "Materialization: {}",
                        snapshot
                            .and_then(|workspace| workspace.materialization.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    lines.push(Line::from(format!(
                        "Freshness: {}",
                        snapshot
                            .and_then(|workspace| workspace.freshness.clone())
                            .unwrap_or_else(|| "unknown".to_string())
                    )));
                    lines.push(Line::from(""));
                    lines.push(Line::from(status.result.summary.clone()));
                }
                (None, _) if detail.status_loading => {
                    lines.push(Line::from("Loading status information..."));
                    lines.push(Line::from(
                        "You can keep navigating while Yaffle loads this in the background.",
                    ));
                }
                (None, Some(error)) => {
                    lines.push(Line::from("Status information could not be loaded."));
                    lines.push(Line::from("Press `r` in the detail panel to retry."));
                    lines.push(Line::from(""));
                    lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    lines.push(Line::from("Status information loads on demand."));
                    lines.push(Line::from("Press `r` in the detail panel to load it."));
                }
            }
            lines
        }
        DetailTab::Outputs => {
            let mut lines = vec![
                Line::from(format!("Selected workspace: {selected}")),
                Line::from(""),
            ];
            if let Some(run) = detail.active_run.as_ref() {
                if let Some(outputs) = run.progress.workspace_outputs.get(selected) {
                    lines.push(Line::from(if run.running {
                        "Outputs captured so far during this converge:"
                    } else {
                        "Outputs captured during the last converge:"
                    }));
                    lines.push(Line::from(""));
                    if outputs.is_empty() {
                        lines.push(Line::from("No outputs captured for this workspace yet."));
                    } else {
                        for (name, output) in outputs {
                            let value = if output.sensitive == Some(true) {
                                "<sensitive>".to_string()
                            } else {
                                serde_json::to_string(&output.value)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            };
                            lines.push(Line::from(format!("{name} = {value}")));
                        }
                    }
                    return lines;
                }
                if run.running {
                    lines.push(Line::from(
                        "Outputs will appear here as workspaces finish and publish them.",
                    ));
                    return lines;
                }
            }
            match (&detail.outputs_response, &detail.outputs_error) {
                (Some(outputs_response), _) => {
                    let outputs = outputs_response
                        .workspace_outputs
                        .get(selected)
                        .cloned()
                        .unwrap_or_default();
                    if outputs.is_empty() {
                        lines.push(Line::from("No outputs found for this workspace yet."));
                    } else {
                        for (name, output) in outputs {
                            let value = if output.sensitive == Some(true) {
                                "<sensitive>".to_string()
                            } else {
                                serde_json::to_string(&output.value)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            };
                            lines.push(Line::from(format!("{name} = {value}")));
                        }
                    }
                }
                (None, _) if detail.outputs_loading => {
                    lines.push(Line::from("Loading outputs..."));
                    lines.push(Line::from(
                        "You can keep navigating while Yaffle loads this in the background.",
                    ));
                }
                (None, Some(error)) => {
                    lines.push(Line::from("Outputs could not be loaded."));
                    lines.push(Line::from("Press `r` in the detail panel to retry."));
                    lines.push(Line::from(""));
                    lines.push(Line::from(error.clone()));
                }
                (None, None) => {
                    lines.push(Line::from("Outputs load on demand."));
                    lines.push(Line::from("Press `r` in the detail panel to load them."));
                }
            }
            lines
        }
    }
}

fn panel_border_style(selected: bool) -> Style {
    if selected {
        Style::default()
            .fg(YAFFLE_CREAM)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(YAFFLE_BORDER_ACCENT)
    }
}

fn summarize_selected_workspaces(detail: &LocalEnvironmentDetailState) -> String {
    let selected = ordered_selected_workspaces(detail);

    if selected.is_empty() {
        return "Selected for converge (0): none".to_string();
    }

    let preview = selected
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if selected.len() > 3 { ", ..." } else { "" };

    format!(
        "Selected for converge ({}): {}{}",
        selected.len(),
        preview,
        suffix
    )
}

fn ordered_selected_workspaces(detail: &LocalEnvironmentDetailState) -> Vec<String> {
    detail
        .levels
        .iter()
        .flat_map(|level| level.iter())
        .filter(|workspace| detail.selected_workspaces.contains(workspace.as_str()))
        .cloned()
        .collect()
}

fn render_detail_tab_chip(label: &str, selected: bool) -> Span<'static> {
    if selected {
        Span::styled(
            format!("[{label}]"),
            Style::default()
                .fg(YAFFLE_CREAM)
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
        )
    } else {
        Span::styled(label.to_string(), Style::default().fg(YAFFLE_TEXT_MUTED))
    }
}

fn render_environment_dag(detail: &LocalEnvironmentDetailState) -> Vec<Line<'static>> {
    let box_width = 24usize;
    let column_gap = 8usize;
    let row_gap = 2usize;
    let row_height = 3usize;

    let width = detail.levels.len().max(1) * (box_width + column_gap) + 4;
    let max_rows = detail.levels.iter().map(Vec::len).max().unwrap_or(1);
    let height = max_rows * (row_height + row_gap) + 3;
    let mut canvas = vec![
        vec![
            DagCell {
                ch: ' ',
                style: Style::default().fg(YAFFLE_TEXT_MUTED),
            };
            width
        ];
        height
    ];

    let mut positions = BTreeMap::new();
    for (level_index, level) in detail.levels.iter().enumerate() {
        let x = level_index * (box_width + column_gap) + 2;
        for (row_index, workspace) in level.iter().enumerate() {
            let y = row_index * (row_height + row_gap) + 1;
            positions.insert(workspace.clone(), (x, y));
            draw_workspace_box(
                &mut canvas,
                x,
                y,
                box_width,
                workspace,
                detail,
                level_index,
                row_index,
            );
        }
    }

    for workspace in &detail.graph.workspaces {
        let Some((target_x, target_y)) = positions.get(&workspace.path).copied() else {
            continue;
        };
        for dependency in &workspace.dependencies {
            let Some((source_x, source_y)) = positions.get(dependency).copied() else {
                continue;
            };

            let source_mid_x = source_x + box_width;
            let source_mid_y = source_y + 1;
            let target_mid_x = target_x.saturating_sub(2);
            let target_mid_y = target_y + 1;
            let bend_x = target_mid_x.saturating_sub(2);

            draw_horizontal(&mut canvas, source_mid_x, bend_x, source_mid_y);
            draw_vertical(&mut canvas, bend_x, source_mid_y, target_mid_y);
            draw_horizontal(&mut canvas, bend_x, target_mid_x, target_mid_y);
            if target_mid_x < width {
                canvas[target_mid_y][target_mid_x] = DagCell {
                    ch: '▶',
                    style: Style::default().fg(YAFFLE_BORDER_ACCENT),
                };
            }
        }
    }

    canvas
        .into_iter()
        .map(|row| {
            let trimmed_len = row
                .iter()
                .rposition(|cell| cell.ch != ' ')
                .map(|index| index + 1)
                .unwrap_or(0);
            let mut spans = Vec::new();
            let mut current_text = String::new();
            let mut current_style: Option<Style> = None;

            for cell in row.into_iter().take(trimmed_len) {
                if current_style == Some(cell.style) {
                    current_text.push(cell.ch);
                } else {
                    if let Some(style) = current_style.take() {
                        spans.push(Span::styled(current_text.clone(), style));
                        current_text.clear();
                    }
                    current_style = Some(cell.style);
                    current_text.push(cell.ch);
                }
            }

            if let Some(style) = current_style {
                spans.push(Span::styled(current_text, style));
            }

            Line::from(spans)
        })
        .collect()
}

fn draw_workspace_box(
    canvas: &mut [Vec<DagCell>],
    x: usize,
    y: usize,
    width: usize,
    workspace: &str,
    detail: &LocalEnvironmentDetailState,
    level_index: usize,
    row_index: usize,
) {
    let selected_cursor = detail.selected_level == level_index && detail.selected_row == row_index;
    let selected_for_converge = detail.selected_workspaces.contains(workspace);
    let border_style = if selected_cursor {
        Style::default()
            .fg(YAFFLE_CREAM)
            .add_modifier(Modifier::BOLD)
    } else if selected_for_converge {
        Style::default()
            .fg(YAFFLE_GREEN)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(YAFFLE_BORDER_ACCENT)
    };
    let text_style = if selected_cursor {
        Style::default()
            .fg(YAFFLE_CREAM)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(YAFFLE_TEXT)
    };
    let status_char =
        if let Some((run_state, phase)) = detail.active_run_status_for_workspace(workspace) {
            match (run_state, phase) {
                (WorkspaceRunState::Running, _) => '▶',
                (WorkspaceRunState::Succeeded, _) => '●',
                (WorkspaceRunState::Failed, _) => '✕',
                (WorkspaceRunState::Pending, _) => '○',
            }
        } else {
            let snapshot = detail.status_response.as_ref().and_then(|response| {
                response
                    .workspaces
                    .iter()
                    .find(|item| item.workspace_path == workspace)
            });
            match snapshot.and_then(|item| item.materialization.as_deref()) {
                Some("present") => '●',
                Some("partially_present") => '◐',
                Some("absent") => '○',
                _ => '·',
            }
        };

    write_styled_string(
        canvas,
        x,
        y,
        &format!("┌{}┐", "─".repeat(width.saturating_sub(2))),
        border_style,
    );
    let label = truncate_workspace_label(workspace, width.saturating_sub(6));
    let include = if selected_for_converge { '■' } else { '□' };
    write_styled_string(canvas, x, y + 1, "│", border_style);
    write_styled_string(canvas, x + 1, y + 1, &include.to_string(), border_style);
    write_styled_string(canvas, x + 2, y + 1, &status_char.to_string(), text_style);
    write_styled_string(canvas, x + 3, y + 1, " ", text_style);
    write_styled_string(
        canvas,
        x + 4,
        y + 1,
        &format!("{label:<width$}", width = width.saturating_sub(6)),
        text_style,
    );
    write_styled_string(canvas, x + width - 1, y + 1, "│", border_style);
    write_styled_string(
        canvas,
        x,
        y + 2,
        &format!("└{}┘", "─".repeat(width.saturating_sub(2))),
        border_style,
    );
}

fn draw_horizontal(canvas: &mut [Vec<DagCell>], start_x: usize, end_x: usize, y: usize) {
    let (from, to) = if start_x <= end_x {
        (start_x, end_x)
    } else {
        (end_x, start_x)
    };
    for x in from..=to {
        overlay_char(canvas, x, y, '─', Style::default().fg(YAFFLE_BORDER));
    }
}

fn draw_vertical(canvas: &mut [Vec<DagCell>], x: usize, start_y: usize, end_y: usize) {
    let (from, to) = if start_y <= end_y {
        (start_y, end_y)
    } else {
        (end_y, start_y)
    };
    for y in from..=to {
        overlay_char(canvas, x, y, '│', Style::default().fg(YAFFLE_BORDER));
    }
}

fn overlay_char(canvas: &mut [Vec<DagCell>], x: usize, y: usize, value: char, style: Style) {
    if y >= canvas.len() || x >= canvas[y].len() {
        return;
    }
    let current = canvas[y][x].ch;
    canvas[y][x] = match (current, value) {
        ('│', '─') | ('─', '│') => DagCell { ch: '┼', style },
        (' ', value) => DagCell { ch: value, style },
        (current, _) => DagCell {
            ch: current,
            style: canvas[y][x].style,
        },
    };
}

fn write_styled_string(canvas: &mut [Vec<DagCell>], x: usize, y: usize, text: &str, style: Style) {
    if y >= canvas.len() {
        return;
    }
    for (offset, character) in text.chars().enumerate() {
        let target_x = x + offset;
        if target_x >= canvas[y].len() {
            break;
        }
        canvas[y][target_x] = DagCell {
            ch: character,
            style,
        };
    }
}

fn truncate_workspace_label(label: &str, max_len: usize) -> String {
    if label.chars().count() <= max_len {
        return label.to_string();
    }

    let truncated = label
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>();
    format!("{truncated}…")
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
            current_namespace,
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

    let levels = build_graph_levels(&graph);

    Ok(LocalEnvironmentDetailState {
        environment_name: environment_name.to_string(),
        graph,
        levels,
        selected_level: 0,
        selected_row: 0,
        selected_workspaces: std::collections::BTreeSet::new(),
        focus: ShellFocus::Graph,
        tab: DetailTab::Plan,
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

fn discover_local_environments(
    repo_root: &Path,
    config: &yaffle_config::YaffleConfig,
) -> Vec<LocalEnvironmentEntry> {
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

    let mut environments = config
        .environments
        .iter()
        .map(|environment| LocalEnvironmentEntry {
            name: environment.name.clone(),
            kind: "named".to_string(),
            workspace_count: count_workspaces_for_environment(config, &environment.name),
            local_state_detected: local_state_envs.contains(&environment.name),
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
            local_state_detected: true,
            name: environment,
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

fn build_graph_levels(graph: &ResolvedWorkspaceGraph) -> Vec<Vec<String>> {
    let order = graph
        .topological_order()
        .unwrap_or_else(|_| graph.workspace_paths());
    let mut stages = BTreeMap::<String, usize>::new();
    for workspace_path in &order {
        let dependencies = graph
            .workspace(workspace_path)
            .map(|workspace| workspace.dependencies.clone())
            .unwrap_or_default();
        let stage = dependencies
            .iter()
            .map(|dependency| stages.get(dependency).copied().unwrap_or(0) + 1)
            .max()
            .unwrap_or(0);
        stages.insert(workspace_path.clone(), stage);
    }

    let max_stage = stages.values().copied().max().unwrap_or(0);
    let mut levels = vec![Vec::new(); max_stage + 1];
    for workspace_path in order {
        let stage = stages.get(&workspace_path).copied().unwrap_or(0);
        levels[stage].push(workspace_path);
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
}
