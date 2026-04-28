use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::sync::{LazyLock, Mutex};

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;

pub const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR: &str = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN";
#[cfg(test)]
pub(crate) static LOCAL_FIRST_ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredPrincipalCredential {
    pub principal_id: String,
    pub session_id: String,
    pub token: String,
    pub issued_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionCredential {
    pub token: String,
    pub repo_binding_id: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostedOutputModulePublishRequest<'a> {
    pub canonical_repo_namespace: &'a str,
    pub local_repo_fingerprint: &'a str,
    pub environment_name: &'a str,
    pub workspace_path: &'a str,
    pub state_fingerprint: &'a str,
    pub outputs: &'a serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostedOutputModulePublishResult {
    pub id: String,
    pub repo_binding_id: String,
    pub workspace_path: String,
    pub environment_name: String,
    pub version_serial: u64,
    pub version: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ExecutionCredentialRequest<'a> {
    pub canonical_repo_namespace: &'a str,
    pub local_repo_fingerprint: &'a str,
    pub environment_name: &'a str,
    pub consumer_workspace_path: &'a str,
}

#[derive(Debug, Error)]
pub enum LocalFirstError {
    #[error("{0}")]
    Config(String),
    #[error("failed to read local principal store: {0}")]
    ReadStore(String),
    #[error("failed to write local principal store: {0}")]
    WriteStore(String),
    #[error("failed to call local-first backend: {0}")]
    Http(String),
    #[error("local-first backend rejected the request: {0}")]
    Api(String),
}

#[derive(Debug, Deserialize)]
struct AnonymousSessionResponseEnvelope {
    data: StoredPrincipalCredential,
}

#[derive(Debug, Deserialize)]
struct ExecutionCredentialResponseEnvelope {
    data: ExecutionCredential,
}

#[derive(Debug, Deserialize)]
struct HostedOutputModulePublishResponseEnvelope {
    data: HostedOutputModulePublishResult,
}

#[derive(Debug, Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

pub fn ensure_anonymous_principal() -> Result<StoredPrincipalCredential, LocalFirstError> {
    if let Some(stored) = load_stored_principal()? {
        if !principal_expired(&stored) {
            return Ok(stored);
        }
    }

    let runtime = LocalFirstRuntime::from_env()?;
    let response = runtime
        .client
        .post(runtime.endpoint_url("/api/sessions/anonymous"))
        .headers(runtime.feature_headers()?)
        .send()
        .map_err(|error| LocalFirstError::Http(error.to_string()))?;

    if !response.status().is_success() {
        return Err(LocalFirstError::Api(read_api_error(response)?));
    }

    let stored = response
        .json::<AnonymousSessionResponseEnvelope>()
        .map_err(|error| LocalFirstError::Http(error.to_string()))?
        .data;
    persist_principal(&stored)?;
    Ok(stored)
}

pub fn mint_execution_credential(
    principal: &StoredPrincipalCredential,
    request: &ExecutionCredentialRequest<'_>,
) -> Result<ExecutionCredential, LocalFirstError> {
    let runtime = LocalFirstRuntime::from_env()?;
    let response = runtime
        .client
        .post(runtime.endpoint_url("/api/execution-tokens"))
        .headers(runtime.authorized_headers(&principal.token)?)
        .json(&serde_json::json!({
            "canonicalRepoNamespace": request.canonical_repo_namespace,
            "localRepoFingerprint": request.local_repo_fingerprint,
            "environmentName": request.environment_name,
            "consumerWorkspacePath": request.consumer_workspace_path,
        }))
        .send()
        .map_err(|error| LocalFirstError::Http(error.to_string()))?;

    if !response.status().is_success() {
        return Err(LocalFirstError::Api(read_api_error(response)?));
    }

    response
        .json::<ExecutionCredentialResponseEnvelope>()
        .map(|value| value.data)
        .map_err(|error| LocalFirstError::Http(error.to_string()))
}

pub fn publish_hosted_output_module(
    principal: &StoredPrincipalCredential,
    request: &HostedOutputModulePublishRequest<'_>,
) -> Result<HostedOutputModulePublishResult, LocalFirstError> {
    let runtime = LocalFirstRuntime::from_env()?;
    let response = runtime
        .client
        .put(runtime.endpoint_url("/api/output-modules"))
        .headers(runtime.authorized_headers(&principal.token)?)
        .json(&serde_json::json!({
            "canonicalRepoNamespace": request.canonical_repo_namespace,
            "localRepoFingerprint": request.local_repo_fingerprint,
            "environmentName": request.environment_name,
            "workspacePath": request.workspace_path,
            "stateFingerprint": request.state_fingerprint,
            "outputs": request.outputs,
        }))
        .send()
        .map_err(|error| LocalFirstError::Http(error.to_string()))?;

    if !response.status().is_success() {
        return Err(LocalFirstError::Api(read_api_error(response)?));
    }

    response
        .json::<HostedOutputModulePublishResponseEnvelope>()
        .map(|value| value.data)
        .map_err(|error| LocalFirstError::Http(error.to_string()))
}

pub fn local_first_feature_token_configured() -> bool {
    env::var(LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub fn compute_local_repo_fingerprint(repo_root: &Path) -> Result<String, LocalFirstError> {
    let canonical = repo_root.canonicalize().map_err(|error| {
        LocalFirstError::Config(format!("failed to canonicalize repo path: {error}"))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn local_auth_store_path() -> Result<PathBuf, LocalFirstError> {
    let home = env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        LocalFirstError::Config("HOME must be set to persist local-first auth".to_string())
    })?;
    Ok(home.join(".yaffle/auth/principal.json"))
}

pub fn module_api_base_url() -> Result<String, LocalFirstError> {
    let host = env::var("YAFFLE_MODULE_API_HOST")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "yaffle.dev".to_string());

    if host.starts_with("http://") || host.starts_with("https://") {
        return Ok(host);
    }

    Ok(format!("https://{host}"))
}

fn load_stored_principal() -> Result<Option<StoredPrincipalCredential>, LocalFirstError> {
    let path = local_auth_store_path()?;
    if !path.is_file() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(path).map_err(|error| LocalFirstError::ReadStore(error.to_string()))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| LocalFirstError::ReadStore(error.to_string()))
}

fn persist_principal(principal: &StoredPrincipalCredential) -> Result<(), LocalFirstError> {
    let path = local_auth_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| LocalFirstError::WriteStore(error.to_string()))?;
    }

    let content = serde_json::to_vec_pretty(principal)
        .map_err(|error| LocalFirstError::WriteStore(error.to_string()))?;
    fs::write(path, content).map_err(|error| LocalFirstError::WriteStore(error.to_string()))
}

fn principal_expired(principal: &StoredPrincipalCredential) -> bool {
    let Some(expires_at) = &principal.expires_at else {
        return false;
    };

    let Ok(parsed) = time::OffsetDateTime::parse(expires_at, &Rfc3339) else {
        return false;
    };

    parsed <= time::OffsetDateTime::now_utc()
}

struct LocalFirstRuntime {
    client: Client,
    feature_token: String,
    base_url: String,
}

impl LocalFirstRuntime {
    fn from_env() -> Result<Self, LocalFirstError> {
        let feature_token = env::var(LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                LocalFirstError::Config(format!(
                    "{} must be set to access local-first backend APIs",
                    LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR
                ))
            })?;

        Ok(Self {
            client: Client::builder()
                .build()
                .map_err(|error| LocalFirstError::Config(error.to_string()))?,
            feature_token,
            base_url: module_api_base_url()?,
        })
    }

    fn endpoint_url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn feature_headers(&self) -> Result<reqwest::header::HeaderMap, LocalFirstError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "feature-token",
            self.feature_token
                .parse::<HeaderValue>()
                .map_err(|error| LocalFirstError::Config(error.to_string()))?,
        );
        Ok(headers)
    }

    fn authorized_headers(
        &self,
        bearer_token: &str,
    ) -> Result<reqwest::header::HeaderMap, LocalFirstError> {
        let mut headers = self.feature_headers()?;
        headers.insert(
            AUTHORIZATION,
            format!("Bearer {bearer_token}")
                .parse::<HeaderValue>()
                .map_err(|error| LocalFirstError::Config(error.to_string()))?,
        );
        Ok(headers)
    }
}

fn read_api_error(response: reqwest::blocking::Response) -> Result<String, LocalFirstError> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| LocalFirstError::Http(error.to_string()))?;
    if let Ok(parsed) = serde_json::from_str::<ApiErrorEnvelope>(&body) {
        return Ok(format!(
            "{}: {} ({})",
            parsed.error.code, parsed.error.message, status
        ));
    }

    Ok(format!("{} {}", status, body))
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn ensures_anonymous_principal_and_mints_execution_token() {
        let _guard = LOCAL_FIRST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_home = TempDir::new().expect("temp dir should exist");
        let server = TestServer::start();

        let previous_home = env::var_os("HOME");
        let previous_host = env::var_os("YAFFLE_MODULE_API_HOST");
        let previous_feature_token = env::var_os(LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR);

        env::set_var("HOME", temp_home.path());
        env::set_var(
            "YAFFLE_MODULE_API_HOST",
            format!("http://{}", server.authority()),
        );
        env::set_var(LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR, "test-feature-token");

        let principal = ensure_anonymous_principal().expect("principal bootstrap should succeed");
        let execution = mint_execution_credential(
            &principal,
            &ExecutionCredentialRequest {
                canonical_repo_namespace: "test-org--fixture",
                local_repo_fingerprint: "repo-fingerprint-1",
                environment_name: "pr-42",
                consumer_workspace_path: "apps/web/infra",
            },
        )
        .expect("execution credential should mint");
        let published = publish_hosted_output_module(
            &principal,
            &HostedOutputModulePublishRequest {
                canonical_repo_namespace: "test-org--fixture",
                local_repo_fingerprint: "repo-fingerprint-1",
                environment_name: "pr-42",
                workspace_path: "infra/shared",
                state_fingerprint: "fingerprint-1",
                outputs: &serde_json::Map::from_iter([(
                    "service_name".to_string(),
                    serde_json::json!({
                        "value": "shared",
                        "type_name": "string",
                        "sensitive": false,
                    }),
                )]),
            },
        )
        .expect("hosted output module should publish");
        let stored_path = local_auth_store_path().expect("store path should resolve");

        restore_env("HOME", previous_home);
        restore_env("YAFFLE_MODULE_API_HOST", previous_host);
        restore_env(LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR, previous_feature_token);

        assert_eq!(principal.principal_id, "principal-test");
        assert_eq!(principal.session_id, "session-test");
        assert_eq!(execution.repo_binding_id, "binding-test");
        assert_eq!(execution.token, "execution-token-test");
        assert_eq!(published.version, "1.0.1");
        assert!(stored_path.ends_with(Path::new(".yaffle/auth/principal.json")));
        assert!(stored_path.is_file());
    }

    fn restore_env(name: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            env::set_var(name, value);
        } else {
            env::remove_var(name);
        }
    }

    struct TestServer {
        authority: String,
        _join_handle: thread::JoinHandle<()>,
    }

    impl TestServer {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
            let authority = listener
                .local_addr()
                .expect("address should exist")
                .to_string();
            let join_handle = thread::spawn(move || {
                for _ in 0..3 {
                    let (mut stream, _) = listener.accept().expect("connection should accept");
                    let mut buffer = [0_u8; 8192];
                    let bytes_read = stream.read(&mut buffer).expect("request should read");
                    let request = String::from_utf8_lossy(&buffer[..bytes_read]);

                    if request.starts_with("POST /api/sessions/anonymous HTTP/1.1") {
                        assert!(request.contains("feature-token: test-feature-token"));
                        let body = r#"{"data":{"principal_id":"principal-test","session_id":"session-test","token":"principal-token-test","issued_at":"2026-04-28T00:00:00Z","expires_at":"2030-04-28T00:00:00Z"}}"#;
                        write_response(&mut stream, body);
                    } else if request.starts_with("POST /api/execution-tokens HTTP/1.1") {
                        assert!(request.contains("authorization: Bearer principal-token-test"));
                        assert!(request.contains("feature-token: test-feature-token"));
                        let body = r#"{"data":{"token":"execution-token-test","repo_binding_id":"binding-test","expires_at":"2030-04-28T00:15:00Z"}}"#;
                        write_response(&mut stream, body);
                    } else if request.starts_with("PUT /api/output-modules HTTP/1.1") {
                        assert!(request.contains("authorization: Bearer principal-token-test"));
                        assert!(request.contains("feature-token: test-feature-token"));
                        let body = r#"{"data":{"id":"module-test","repo_binding_id":"binding-test","workspace_path":"infra/shared","environment_name":"pr-42","version_serial":1,"version":"1.0.1","created_at":"2030-04-28T00:00:00Z"}}"#;
                        write_response(&mut stream, body);
                    } else {
                        panic!("unexpected request: {request}");
                    }
                }
            });

            Self {
                authority,
                _join_handle: join_handle,
            }
        }

        fn authority(&self) -> &str {
            &self.authority
        }
    }

    fn write_response(stream: &mut std::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("response should write");
    }
}
