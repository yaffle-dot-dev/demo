use anyhow::{bail, Result};

pub fn validate_environment_name(environment: &str) -> Result<()> {
    if environment.trim().is_empty() {
        bail!("environment name must not be empty")
    }

    Ok(())
}
