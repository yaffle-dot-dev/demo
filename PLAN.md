# 🪶 Yaffle - Project Decisions

> *Yaffle* — Old English for woodpecker. They tap to test before committing.

**Domain:** yaffle.dev

---

## What We're Building

**Core:** A Terraform runner with ephemeral preview workspaces, triggered by Source Forge (ex GitHub) webhook events (like PR, merge, ...).
**Layer on top:** Codegen for users who don't have Terraform yet (Grafana JSON → TF).

**Build order:**
1. TF runner (dogfood immediately)
2. Codegen (adoption wedge)

---

## The Foundation: Terraform Runner
At its core, Yaffle is:

```
PR with Terraform changes
         │
         ▼
┌─────────────────────────────────────────┐
│  terraform plan → terraform apply       │
│  State stored in S3                     │
│  Results posted to GitHub               │
└─────────────────────────────────────────┘
```

This is the product. Everything else is layers on top.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Repo                              │
│                                                                 │
│   Option A: Raw Terraform                                       │
│   └── infra/*.tf                                                │
│                                                                 │
│   Option B: Source files + Yaffle codegen                       │
│   └── dashboards/*.json + .yaffle/config.yml                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │ PR opened
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Yaffle Control Plane                         │
│                                                                 │
│   ┌─────────────┐                                               │
│   │  Webhook    │                                               │
│   │  Handler    │                                               │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────────────────────────────────────────┐          │
│   │  Is this raw TF or needs codegen?               │          │
│   │                                                 │          │
│   │  Raw TF (.tf files)     │  Codegen needed       │          │
│   │  └── Use directly       │  └── Generate TF      │          │
│   └─────────────────────────────────────────────────┘          │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐          │
│   │  Workspace  │──▶│  TF Runner  │──▶│  GitHub     │          │
│   │  Manager    │   │  (ECS)      │   │  Check      │          │
│   └─────────────┘   └─────────────┘   └─────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         S3 State                                │
│                                                                 │
│   yaffle-state-{org}/                                           │
│   ├── previews/pr-247/terraform.tfstate   ← Ephemeral          │
│   └── production/main/terraform.tfstate   ← Persistent         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Target Infrastructure                        │
│                                                                 │
│   AWS        Grafana       Snowflake       Anything with       │
│   resources  dashboards    schemas         a TF provider       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Two Modes of Operation

### Mode 1: Raw Terraform (Day 1)

User already has Terraform. We just run it.

```
repo/
├── infra/
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
└── .yaffle/config.yml
```

```yaml
# .yaffle/config.yml
version: 1

terraform:
  paths:
    - infra/**/*.tf
  preview:
    workspace_prefix: preview
  production:
    workspace: production
```

**PR opened → we run their TF with preview workspace → PR merged → we run with production workspace**

### Mode 2: Codegen (Later)

User has source files, no Terraform. We generate it.

```
repo/
├── dashboards/
│   └── revenue.json
└── .yaffle/config.yml
```

```yaml
# .yaffle/config.yml
version: 1

components:
  grafana:
    type: grafana
    connection: grafana-prod
    paths:
      - dashboards/**/*.json
```

**PR opened → we generate TF from JSON → run it → same flow**

---

## Dogfooding: Yaffle Runs Yaffle
From day 1, Yaffle's own infrastructure runs through Yaffle.

```
yaffle/
├── infra/
│   ├── main.tf           # ECS, S3, RDS, etc.
│   ├── ecs.tf
│   ├── s3.tf
│   └── ...
├── apps/
│   ├── api/
│   └── web/
└── .yaffle/config.yml
```

**Our workflow:**
1. Open PR with infra changes
2. Yaffle (running locally initially) plans against preview workspace
3. See plan in GitHub Check
4. Merge → applies to production workspace

**Bootstrap sequence:**
1. Run TF locally to create initial infra
2. Deploy Yaffle API
3. Point Yaffle at itself
4. Now PRs flow through Yaffle

---

## State Model

```
S3 Bucket: yaffle-state-{org}

├── previews/
│   ├── pr-123/
│   │   └── terraform.tfstate    # Lives while PR is open
│   ├── pr-247/
│   │   └── terraform.tfstate
│   └── pr-302/
│       └── terraform.tfstate
│
└── production/
    └── main/
        └── terraform.tfstate    # Persistent, updated on merge
```

**Lifecycle:**
- PR opened → create `previews/pr-{n}/`
- PR updated → apply to same state
- PR closed → `terraform destroy` + delete state
- PR merged → apply to `production/main/` + destroy preview

---

## Preview Isolation

Each preview gets:
- Unique state file (no conflicts)
- Unique resource naming (via variables)

```hcl
# User's main.tf
variable "environment" {
  type = string
}

resource "aws_s3_bucket" "data" {
  bucket = "myapp-data-${var.environment}"
}
```

**Yaffle injects:**
- Preview: `environment = "preview-pr-247"`
- Production: `environment = "production"`

---

## The TF Runner

### Container

```dockerfile
FROM hashicorp/terraform:1.7

# Pre-cache providers
COPY provider-cache/ /root/.terraform.d/plugin-cache/

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

```bash
#!/bin/bash
# entrypoint.sh

set -e

# Inputs from environment
WORKSPACE_S3_PATH=$1    # s3://bucket/workspace.tar.gz
STATE_BUCKET=$2
STATE_KEY=$3
COMMAND=$4              # plan | apply | destroy
VARS_JSON=$5            # {"environment": "preview-pr-247", ...}

# Download workspace
aws s3 cp $WORKSPACE_S3_PATH workspace.tar.gz
tar -xzf workspace.tar.gz

cd workspace

# Configure backend
cat > backend_override.tf <<EOF
terraform {
  backend "s3" {
    bucket         = "${STATE_BUCKET}"
    key            = "${STATE_KEY}"
    region         = "us-east-1"
    dynamodb_table = "yaffle-locks"
    encrypt        = true
  }
}
EOF

# Write vars
echo $VARS_JSON > terraform.tfvars.json

# Init
terraform init -input=false

# Run command
case $COMMAND in
  plan)
    terraform plan -out=tfplan -input=false
    terraform show -json tfplan > /results/plan.json
    ;;
  apply)
    terraform apply -auto-approve -input=false
    terraform output -json > /results/outputs.json
    ;;
  destroy)
    terraform destroy -auto-approve -input=false
    ;;
esac

echo "Done"
```

### Execution

```typescript
async function runTerraform(opts: {
  workspaceS3Path: string
  stateBucket: string
  stateKey: string
  command: 'plan' | 'apply' | 'destroy'
  variables: Record<string, string>
  secretArns: string[]  // Secrets to inject as TF vars
}): Promise<TerraformResult> {
  
  // Start ECS task
  const task = await ecs.runTask({
    cluster: 'yaffle-runners',
    taskDefinition: 'yaffle-tf-runner',
    launchType: 'FARGATE',
    networkConfiguration: { ... },
    overrides: {
      containerOverrides: [{
        name: 'terraform',
        command: [
          opts.workspaceS3Path,
          opts.stateBucket,
          opts.stateKey,
          opts.command,
          JSON.stringify(opts.variables),
        ],
      }],
    },
  })
  
  // Wait for completion
  await waitForTask(task.taskArn)
  
  // Fetch results
  const results = await s3.getObject({
    Bucket: opts.stateBucket,
    Key: `results/${task.taskArn}/outputs.json`,
  })
  
  return JSON.parse(results.Body)
}
```

---

## GitHub Integration

### Webhook Events
- `pull_request.opened` → plan + apply preview
- `pull_request.synchronize` → plan + apply preview (update)
- `pull_request.closed` → destroy preview
- `pull_request.closed` (merged) → apply production + destroy preview

### Check Runs

```
PR #247: "Add caching layer"

Checks:
├── ✅ CI / tests
└── 🟡 Yaffle / terraform
       Plan: +3, ~1, -0
       [View Plan] [View Preview]
```

**Plan output in Check:**
```
Terraform will perform the following actions:

  # aws_elasticache_cluster.cache will be created
  + resource "aws_elasticache_cluster" "cache" {
      + cluster_id           = "myapp-cache-preview-pr-247"
      + engine               = "redis"
      + node_type            = "cache.t3.micro"
      ...
    }

Plan: 3 to add, 1 to change, 0 to destroy.
```

---

## Config File Schema

```yaml
# .yaffle/config.yml
version: 1

# === Option 1: Raw Terraform ===
terraform:
  # Which paths contain TF files
  paths:
    - infra/**/*.tf
  
  # Variables to inject
  variables:
    environment: "{{ yaffle.environment }}"  # preview-pr-N or production
    preview_id: "{{ yaffle.preview_id }}"
  
  # Secrets to inject as TF vars (from Secrets Manager)
  secrets:
    - name: db_password
      arn: arn:aws:secretsmanager:...:db-password
  
  # Preview settings
  preview:
    auto_apply: true      # Apply on PR open, or wait for manual trigger
    ttl: 72h              # Auto-destroy after
  
  # Production settings  
  production:
    require_approval: true  # Require check approval before merge applies

# === Option 2: Codegen (can combine with Option 1) ===
components:
  grafana:
    type: grafana
    connection: grafana-prod
    paths:
      - dashboards/**/*.json
    production:
      folder_uid: prod-dashboards
```

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Control Plane** | Hono + Bun | Lightweight |
| **Frontend** | SvelteKit | Elegant |
| **Auth** | BetterAuth | SSO-ready, DB sessions |
| **Database** | Postgres (Neon → RDS) | Jobs, metadata, sessions |
| **TF Execution** | ECS Fargate | Isolated, scalable |
| **State Storage** | S3 | Standard TF backend |
| **State Locking** | DynamoDB | Standard TF locking |
| **Secrets** | AWS Secrets Manager | TF var injection |

---

## Authentication & Authorization

> Full details in [docs/authentication.md](docs/authentication.md)

### Design Principles

1. **Frictionless for early adopters** - Install GitHub App, share link, team joins in minutes
2. **Enterprise-ready** - SSO/SAML, audit trails, compliance when needed
3. **Decoupled from GitHub** - Yaffle orgs are independent; GitHub is one integration

### How Membership Works

**Default mode: GitHub Self-Join**

```
Alice installs GitHub App on "acme-corp"
    │
    ▼
Yaffle creates org, Alice is admin
    │
    ▼
Alice shares link: "Sign in at yaffle.dev"
    │
    ▼
Bob signs in with GitHub
    │
    ▼
Bob sees: "Join acme-corp? (You're a member on GitHub)"
    │
    ▼
One click → Bob is a viewer
```

- **Trust signal**: GitHub org membership = trusted with code = can see TF plans
- **Explicit action**: Users click "Join", not auto-added
- **Auditable**: Every membership records its source

**Enterprise upgrade path:**

- Set `membership_mode = 'invite_only'` or `'sso_only'`
- Self-join disabled, existing members keep access
- New members via invite or SCIM provisioning

### Roles

| Role | Can Do |
|------|--------|
| `viewer` | View previews, plans, logs |
| `approver` | + Approve applies |
| `admin` | + Manage members, org settings |

---

## Database Schema

> **Note:** Auth tables (`user`, `account`, `session`, `verification`) are managed
> by BetterAuth. See [docs/authentication.md](docs/authentication.md) for the
> complete auth schema.

```sql
-- Organizations (decoupled from GitHub)
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  state_bucket TEXT,                -- S3 bucket for TF state (nullable until configured)
  runner_mode TEXT DEFAULT 'saas',  -- 'saas' | 'byoa'
  membership_mode TEXT DEFAULT 'github_self_join',  -- 'github_self_join' | 'invite_only' | 'sso_only'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Links Yaffle orgs to GitHub App installations
CREATE TABLE github_installations (
  id UUID PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  github_org_id BIGINT NOT NULL,
  github_org_login TEXT NOT NULL,
  installation_id BIGINT UNIQUE NOT NULL,
  installation_status TEXT DEFAULT 'active',  -- 'active' | 'suspended' | 'uninstalled'
  installed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User membership in organizations
CREATE TABLE org_memberships (
  id UUID PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,  -- BetterAuth user ID
  role TEXT NOT NULL,               -- 'viewer' | 'approver' | 'admin'
  source TEXT NOT NULL,             -- 'github_self_join' | 'invite' | 'scim' | 'admin_bootstrap'
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Connections (for codegen mode)
CREATE TABLE connections (
  id UUID PRIMARY KEY,
  org_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  secret_arn TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Previews
CREATE TABLE previews (
  id UUID PRIMARY KEY,
  org_id UUID REFERENCES organizations(id),
  repo TEXT NOT NULL,
  pr_number INT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending|planning|applying|ready|failed|destroying|destroyed
  state_key TEXT NOT NULL,
  mode TEXT NOT NULL,             -- 'terraform' | 'codegen'
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, repo, pr_number)
);

-- TF Runs
CREATE TABLE tf_runs (
  id UUID PRIMARY KEY,
  preview_id UUID REFERENCES previews(id),
  run_type TEXT NOT NULL,         -- 'plan' | 'apply' | 'destroy'
  status TEXT NOT NULL,           -- 'pending' | 'running' | 'success' | 'failed'
  ecs_task_arn TEXT,
  plan_summary TEXT,              -- "+3, ~1, -0"
  plan_json JSONB,
  outputs JSONB,
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Approvals
CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  preview_id UUID REFERENCES previews(id),
  user_id TEXT REFERENCES "user"(id),  -- BetterAuth user ID
  approved_at TIMESTAMP DEFAULT NOW()
);

-- Job queue
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT DEFAULT 'pending',
  run_at TIMESTAMP DEFAULT NOW(),
  locked_by TEXT,
  attempts INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Project Structure

```
yaffle/
├── infra/                          # Yaffle's own infrastructure
│   ├── main.tf                     # Dogfood this!
│   ├── ecs.tf
│   ├── s3.tf
│   ├── rds.tf
│   └── ...
│
├── apps/
│   ├── api/                        # Control plane
│   │   └── src/
│   │       ├── index.ts
│   │       ├── routes/
│   │       │   ├── webhooks.ts
│   │       │   ├── previews.ts
│   │       │   └── runs.ts
│   │       ├── lib/
│   │       │   ├── github.ts
│   │       │   ├── aws.ts
│   │       │   ├── terraform.ts    # Orchestrate TF runs
│   │       │   └── db.ts
│   │       ├── codegen/            # For codegen mode
│   │       │   ├── grafana.ts
│   │       │   └── ...
│   │       └── jobs/
│   │           ├── queue.ts
│   │           ├── provision.ts
│   │           └── cleanup.ts
│   │
│   ├── web/                        # SvelteKit frontend
│   │
│   └── runner/                     # TF Runner container
│       ├── Dockerfile
│       └── entrypoint.sh
│
├── modules/
│   └── aws-runner/                 # BYOA module (later)
│
├── .yaffle/
│   └── config.yml                  # Yaffle runs itself
│
└── packages/
    └── shared/
```

---

## Bootstrap Sequence

### Phase 0: Local Development
```bash
# Run control plane locally
bun run dev:control-plane

# TF runs locally (no ECS yet)
cd infra && terraform plan
```

### Phase 1: Manual Cloud Deploy
```bash
# Create initial infra manually
cd infra
terraform init
terraform apply

# Deploy API to ECS
# Deploy web to Vercel
```

### Phase 2: Dogfooding
```yaml
# .yaffle/config.yml
version: 1

terraform:
  paths:
    - infra/**/*.tf
  variables:
    environment: "{{ yaffle.environment }}"
```

```bash
# Install GitHub App on yaffle repo
# Open PR with infra change
# → Yaffle plans it
# → Merge
# → Yaffle applies it
```

**Now Yaffle runs Yaffle.** Every infra change goes through preview.

---

## First Milestones

### Week 1: TF Runner (Local)
- [ ] GitHub webhook handler
- [ ] Detect TF file changes in PR
- [ ] Run `terraform plan` locally
- [ ] Post plan output to GitHub Check
- [ ] Run `terraform apply` locally
- [ ] Handle PR close (destroy)

### Week 2: TF Runner (Cloud)
- [ ] ECS cluster + task definition
- [ ] S3 state bucket
- [ ] DynamoDB lock table
- [ ] Runner container image
- [ ] Trigger ECS tasks from API
- [ ] Fetch results from S3

### Week 3: Dogfooding
- [ ] Yaffle's infra in `infra/`
- [ ] `.yaffle/config.yml` for self
- [ ] Install GitHub App on yaffle repo
- [ ] First PR through the system

### Week 4: Polish + Codegen Start
- [ ] Error handling, retries
- [ ] Logs streaming
- [ ] UI for viewing runs
- [ ] Start Grafana codegen

---
## The Bet

**Terraform is the lingua franca of infrastructure.** We're building the best way to preview TF changes.

**Dogfooding from day 1** means we feel our own pain. If it sucks to use, we'll know immediately.

**Codegen is an adoption wedge**, not the core product. Core is: run TF, manage state, show previews.

---

*Tap to check before you commit.* 🪶
