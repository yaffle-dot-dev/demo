
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SHELL: string;
	export const npm_command: string;
	export const GHOSTTY_BIN_DIR: string;
	export const COLORTERM: string;
	export const __HM_SESS_VARS_SOURCED: string;
	export const XDG_CONFIG_DIRS: string;
	export const hardeningDisable: string;
	export const XPC_FLAGS: string;
	export const NIX_BINTOOLS_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
	export const TERM_PROGRAM_VERSION: string;
	export const configureFlags: string;
	export const CARAPACE_ZSH_HASH_DIRS: string;
	export const PC_CONFIG_FILES: string;
	export const mesonFlags: string;
	export const PKG_CONFIG_PATH: string;
	export const SECRETSPEC_PROVIDER: string;
	export const PYTHONNOUSERSITE: string;
	export const DEVENV_TASK_FILE: string;
	export const PREK_HOME: string;
	export const __sandboxProfile: string;
	export const NODE: string;
	export const PC_REPLICA_NUM: string;
	export const PGPORT: string;
	export const PYTHONHASHSEED: string;
	export const CARAPACE_SHELL_BUILTINS: string;
	export const __CFBundleIdentifier: string;
	export const SSH_AUTH_SOCK: string;
	export const DIRENV_DIR: string;
	export const SMEE_URL: string;
	export const STRINGS: string;
	export const npm_config_local_prefix: string;
	export const HOMEBREW_PREFIX: string;
	export const GNUPGHOME: string;
	export const DIRENV_FILE: string;
	export const EDITOR: string;
	export const MACOSX_DEPLOYMENT_TARGET: string;
	export const PWD: string;
	export const NIX_PROFILES: string;
	export const SOURCE_DATE_EPOCH: string;
	export const SDKROOT: string;
	export const LOGNAME: string;
	export const NIX_ENFORCE_NO_NATIVE: string;
	export const __propagatedSandboxProfile: string;
	export const MANPATH: string;
	export const LaunchInstanceID: string;
	export const NIX_CC_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
	export const __NIX_DARWIN_SET_ENVIRONMENT_DONE: string;
	export const CXX: string;
	export const NIX_APPLE_SDK_VERSION: string;
	export const _: string;
	export const FZF_TMUX: string;
	export const system: string;
	export const PC_SOCKET_PATH: string;
	export const DEVENV_DOTFILE: string;
	export const COMMAND_MODE: string;
	export const IN_NIX_SHELL: string;
	export const GHOSTTY_SHELL_FEATURES: string;
	export const HOME: string;
	export const NIX_BINTOOLS: string;
	export const LANG: string;
	export const SECRETSPEC_PROFILE: string;
	export const NIX_DONT_SET_RPATH: string;
	export const SECURITYSESSIONID: string;
	export const DEVENV_FLAKE_SHELL: string;
	export const STARSHIP_SHELL: string;
	export const cmakeFlags: string;
	export const STARSHIP_CONFIG: string;
	export const NIX_SSL_CERT_FILE: string;
	export const NIX_PKG_CONFIG_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
	export const LD_DYLD_PATH: string;
	export const PC_PROC_NAME: string;
	export const NIX_STORE: string;
	export const TMPDIR: string;
	export const DEVENV_ROOT: string;
	export const YAFFLE_TF_BINARY: string;
	export const LD: string;
	export const DIRENV_DIFF: string;
	export const STARSHIP_SESSION_KEY: string;
	export const NIX_USER_PROFILE_DIR: string;
	export const INFOPATH: string;
	export const npm_lifecycle_script: string;
	export const NIX_DONT_SET_RPATH_FOR_BUILD: string;
	export const __propagatedImpureHostDeps: string;
	export const GHOSTTY_RESOURCES_DIR: string;
	export const PYTHONPATH: string;
	export const TERM: string;
	export const TERMINFO: string;
	export const npm_package_name: string;
	export const NIX_NO_SELF_RPATH: string;
	export const PATH_LOCALE: string;
	export const SIZE: string;
	export const USER: string;
	export const CARAPACE_COMPLINE: string;
	export const HOMEBREW_CELLAR: string;
	export const AR: string;
	export const AS: string;
	export const VISUAL: string;
	export const DEVENV_TASKS: string;
	export const npm_lifecycle_event: string;
	export const SHLVL: string;
	export const DEVENV_RUNTIME: string;
	export const NM: string;
	export const PAGER: string;
	export const __HM_ZSH_SESS_VARS_SOURCED: string;
	export const __impureHostDeps: string;
	export const NIX_CFLAGS_COMPILE: string;
	export const ZERO_AR_DATE: string;
	export const NIX_IGNORE_LD_THROUGH_GCC: string;
	export const HOMEBREW_REPOSITORY: string;
	export const DEVENV_IN_DIRENV_SHELL: string;
	export const CARAPACE_SHELL_FUNCTIONS: string;
	export const XPC_SERVICE_NAME: string;
	export const npm_config_user_agent: string;
	export const TERMINFO_DIRS: string;
	export const npm_execpath: string;
	export const DEVENV_PROFILE: string;
	export const NODE_PATH: string;
	export const OBJCOPY: string;
	export const DETERMINISTIC_BUILD: string;
	export const PGHOST: string;
	export const npm_package_json: string;
	export const PGDATA: string;
	export const STRIP: string;
	export const XDG_DATA_DIRS: string;
	export const OBJDUMP: string;
	export const PATH: string;
	export const CARAPACE_SHELL: string;
	export const CC: string;
	export const YAFFLE_ENV: string;
	export const NIX_CC: string;
	export const FZF_DEFAULT_OPTS: string;
	export const DIRENV_WATCHES: string;
	export const DEVENV_STATE: string;
	export const DEVELOPER_DIR: string;
	export const CONFIG_SHELL: string;
	export const npm_node_execpath: string;
	export const RANLIB: string;
	export const NIX_HARDENING_ENABLE: string;
	export const __darwinAllowLocalNetworking: string;
	export const NIX_LDFLAGS: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const name: string;
	export const TERM_PROGRAM: string;
	export const PKG_CONFIG: string;
	export const NODE_ENV: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SHELL: string;
		npm_command: string;
		GHOSTTY_BIN_DIR: string;
		COLORTERM: string;
		__HM_SESS_VARS_SOURCED: string;
		XDG_CONFIG_DIRS: string;
		hardeningDisable: string;
		XPC_FLAGS: string;
		NIX_BINTOOLS_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
		TERM_PROGRAM_VERSION: string;
		configureFlags: string;
		CARAPACE_ZSH_HASH_DIRS: string;
		PC_CONFIG_FILES: string;
		mesonFlags: string;
		PKG_CONFIG_PATH: string;
		SECRETSPEC_PROVIDER: string;
		PYTHONNOUSERSITE: string;
		DEVENV_TASK_FILE: string;
		PREK_HOME: string;
		__sandboxProfile: string;
		NODE: string;
		PC_REPLICA_NUM: string;
		PGPORT: string;
		PYTHONHASHSEED: string;
		CARAPACE_SHELL_BUILTINS: string;
		__CFBundleIdentifier: string;
		SSH_AUTH_SOCK: string;
		DIRENV_DIR: string;
		SMEE_URL: string;
		STRINGS: string;
		npm_config_local_prefix: string;
		HOMEBREW_PREFIX: string;
		GNUPGHOME: string;
		DIRENV_FILE: string;
		EDITOR: string;
		MACOSX_DEPLOYMENT_TARGET: string;
		PWD: string;
		NIX_PROFILES: string;
		SOURCE_DATE_EPOCH: string;
		SDKROOT: string;
		LOGNAME: string;
		NIX_ENFORCE_NO_NATIVE: string;
		__propagatedSandboxProfile: string;
		MANPATH: string;
		LaunchInstanceID: string;
		NIX_CC_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
		__NIX_DARWIN_SET_ENVIRONMENT_DONE: string;
		CXX: string;
		NIX_APPLE_SDK_VERSION: string;
		_: string;
		FZF_TMUX: string;
		system: string;
		PC_SOCKET_PATH: string;
		DEVENV_DOTFILE: string;
		COMMAND_MODE: string;
		IN_NIX_SHELL: string;
		GHOSTTY_SHELL_FEATURES: string;
		HOME: string;
		NIX_BINTOOLS: string;
		LANG: string;
		SECRETSPEC_PROFILE: string;
		NIX_DONT_SET_RPATH: string;
		SECURITYSESSIONID: string;
		DEVENV_FLAKE_SHELL: string;
		STARSHIP_SHELL: string;
		cmakeFlags: string;
		STARSHIP_CONFIG: string;
		NIX_SSL_CERT_FILE: string;
		NIX_PKG_CONFIG_WRAPPER_TARGET_HOST_arm64_apple_darwin: string;
		LD_DYLD_PATH: string;
		PC_PROC_NAME: string;
		NIX_STORE: string;
		TMPDIR: string;
		DEVENV_ROOT: string;
		YAFFLE_TF_BINARY: string;
		LD: string;
		DIRENV_DIFF: string;
		STARSHIP_SESSION_KEY: string;
		NIX_USER_PROFILE_DIR: string;
		INFOPATH: string;
		npm_lifecycle_script: string;
		NIX_DONT_SET_RPATH_FOR_BUILD: string;
		__propagatedImpureHostDeps: string;
		GHOSTTY_RESOURCES_DIR: string;
		PYTHONPATH: string;
		TERM: string;
		TERMINFO: string;
		npm_package_name: string;
		NIX_NO_SELF_RPATH: string;
		PATH_LOCALE: string;
		SIZE: string;
		USER: string;
		CARAPACE_COMPLINE: string;
		HOMEBREW_CELLAR: string;
		AR: string;
		AS: string;
		VISUAL: string;
		DEVENV_TASKS: string;
		npm_lifecycle_event: string;
		SHLVL: string;
		DEVENV_RUNTIME: string;
		NM: string;
		PAGER: string;
		__HM_ZSH_SESS_VARS_SOURCED: string;
		__impureHostDeps: string;
		NIX_CFLAGS_COMPILE: string;
		ZERO_AR_DATE: string;
		NIX_IGNORE_LD_THROUGH_GCC: string;
		HOMEBREW_REPOSITORY: string;
		DEVENV_IN_DIRENV_SHELL: string;
		CARAPACE_SHELL_FUNCTIONS: string;
		XPC_SERVICE_NAME: string;
		npm_config_user_agent: string;
		TERMINFO_DIRS: string;
		npm_execpath: string;
		DEVENV_PROFILE: string;
		NODE_PATH: string;
		OBJCOPY: string;
		DETERMINISTIC_BUILD: string;
		PGHOST: string;
		npm_package_json: string;
		PGDATA: string;
		STRIP: string;
		XDG_DATA_DIRS: string;
		OBJDUMP: string;
		PATH: string;
		CARAPACE_SHELL: string;
		CC: string;
		YAFFLE_ENV: string;
		NIX_CC: string;
		FZF_DEFAULT_OPTS: string;
		DIRENV_WATCHES: string;
		DEVENV_STATE: string;
		DEVELOPER_DIR: string;
		CONFIG_SHELL: string;
		npm_node_execpath: string;
		RANLIB: string;
		NIX_HARDENING_ENABLE: string;
		__darwinAllowLocalNetworking: string;
		NIX_LDFLAGS: string;
		__CF_USER_TEXT_ENCODING: string;
		name: string;
		TERM_PROGRAM: string;
		PKG_CONFIG: string;
		NODE_ENV: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
