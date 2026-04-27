use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tempfile::TempDir;
use yaffle_tofu::{resolve_tofu, TofuResolutionRequest};

pub fn copy_fixture_repo(name: &str) -> TempDir {
    let temp_dir = TempDir::new().expect("temp dir should exist");
    let source = fixture_root().join(name);
    copy_dir_all(&source, temp_dir.path());
    temp_dir
}

pub fn run_tofu_apply(repo_root: &Path, workspace_path: &str) {
    run_tofu(
        repo_root,
        workspace_path,
        &["init", "-input=false", "-no-color"],
    );
    run_tofu(
        repo_root,
        workspace_path,
        &["apply", "-auto-approve", "-input=false", "-no-color"],
    );
}

pub fn run_tofu_output_json(repo_root: &Path, workspace_path: &str) -> Value {
    let resolution = resolve_tofu(&TofuResolutionRequest::default())
        .expect("tofu should resolve for fixture tests");
    let output = resolution
        .command()
        .current_dir(repo_root.join(workspace_path))
        .env("TOFU_IN_AUTOMATION", "1")
        .args(["output", "-json", "-no-color"])
        .output()
        .expect("tofu output should run");

    if !output.status.success() {
        panic!(
            "tofu output failed for fixture workspace '{}': {}",
            workspace_path,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    serde_json::from_slice(&output.stdout).expect("tofu output should be valid json")
}

fn run_tofu(repo_root: &Path, workspace_path: &str, args: &[&str]) {
    let resolution = resolve_tofu(&TofuResolutionRequest::default())
        .expect("tofu should resolve for fixture tests");
    let output = resolution
        .command()
        .current_dir(repo_root.join(workspace_path))
        .env("TOFU_IN_AUTOMATION", "1")
        .args(args)
        .output()
        .expect("tofu command should run");

    if !output.status.success() {
        panic!(
            "tofu {} failed for fixture workspace '{}': {}",
            args.join(" "),
            workspace_path,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate dir should have parent")
        .parent()
        .expect("workspace dir should have parent")
        .join("testdata/engine/repos")
}

fn copy_dir_all(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("destination directory should exist");

    for entry in fs::read_dir(source).expect("source directory should be readable") {
        let entry = entry.expect("directory entry should be readable");
        let path = entry.path();
        let target = destination.join(entry.file_name());

        if path.is_dir() {
            copy_dir_all(&path, &target);
        } else {
            fs::copy(&path, &target).expect("fixture file should copy");
        }
    }
}
