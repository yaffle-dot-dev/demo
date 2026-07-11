# Yaffle Strategic Positioning

> **Status**: DRAFT - Needs validation through customer discovery
> **Purpose**: Define possible market positions to guide GTM and 4Ps decisions

---

## TL;DR

**Insight**: There is no separation between infrastructure and code. They're a unit. You should be able to preview and test the whole thing together.

**Wedge**: Preview your entire system - infra AND the code that runs on it - before it hits production.

**Vision**: Everything managed as a product with safe, previewable change management.

---

## The Core Insight

**Infrastructure and code are not separate things.**

The industry treats them as separate:
- Code goes through CI/CD, preview deploys, staging environments
- Infrastructure goes through... `terraform plan` and prayer

But they're a unit:
- Your app doesn't work without its infrastructure
- Your infrastructure is meaningless without the app
- A change to either can break the whole system

**Yaffle's thesis**: Preview the whole thing together.

### How This Works

1. You open a PR that changes infrastructure (or code, or both)
2. Yaffle spins up preview infrastructure for that PR
3. Yaffle provides outputs (via GitHub Action) so you can deploy your code ONTO that preview infra
4. You test the whole system - infra + code - in isolation
5. You merge with confidence

**The outputs action is key.** It's the bridge between infra preview and code preview. It makes them one thing.

---

## The North Star vs The Wedge

### The Vision (3 Steps Ahead)

Everything managed like a product:
- Platform teams publish versioned, tiered offerings (platinum/gold/bronze stability)
- Product teams self-serve through typed interfaces with clear contracts
- Changes are previewed, tested, and promoted through environments
- Infrastructure, dashboards, configs, policies - all treated as products
- Humans AND agents can safely make changes

**This is where we're going.** But nobody buys a vision.

### The Wedge (Step 1 - What Gets Revenue)

**"Preview your whole system, not just your code."**

Teams already have:
- Preview deploys for frontend (Vercel, Netlify)
- Preview deploys for backend (Railway, Render, etc.)

Teams don't have:
- Preview deploys for infrastructure
- A way to test code + infra together before production

That's the gap. That's the wedge.

**Why now?**
- AI agents are writing more code AND more infrastructure
- Change velocity is increasing
- The blast radius of a bad change is getting bigger
- Teams need safety mechanisms that work for humans AND agents

---

## The Wedge: Preview Your Whole System

### Positioning Statement

> For **engineering teams shipping to production** who are **afraid of breaking things
> with infrastructure or config changes**, Yaffle is a **preview environment platform**
> that **spins up your entire system - infra AND code - in isolation for every PR**.
> Unlike **Vercel or Terraform Cloud**, we **preview infrastructure and code together,
> because they're not separate things**.

### The Buyer

**Title**: DevOps Lead, Platform Lead, Engineering Manager, CTO (at smaller cos)

**Company**: Series A+ startup, 20-500 employees, cloud-native

**Day-to-day**: 
- Shipping features while keeping production stable
- Reviewing changes (code AND infra)
- Debugging production issues after deploys

**Pain points**:
- "We have preview deploys for code but not for infrastructure"
- "I can't test my app against the new infra until it's in production"
- "Our staging environment is a mess and doesn't match production"
- "AI agents are making changes faster than we can review them"

### The Compelling Event

What makes them buy NOW vs never?

1. **Recent outage from a change** - Infra, config, code - doesn't matter. They broke prod.
2. **AI adoption** - Agents writing code/infra faster than humans can review
3. **Scaling pain** - More changes, more deploys, more risk
4. **Staging environment rot** - "We can't trust staging anymore"

### What We're Replacing

**Status quo is the real competitor:**
- Preview deploys for code + `terraform plan` for infra (separate worlds)
- Shared staging environment that's always broken
- "Deploy to prod and hope" (YOLO)
- Manual "apply infra first, then deploy code" sequencing

### Why Us vs Alternatives

| Alternative | Gap We Fill |
|-------------|-------------|
| Vercel/Netlify | Preview code, not infrastructure |
| Terraform Cloud | Plan infrastructure, don't actually create it |
| Spacelift/Env0 | Plan infrastructure, don't actually create it |
| Staging env | Shared, not isolated. Config drift. Not PR-specific. |

**Our differentiation**: Preview infrastructure AND code together, because they're a unit.

The **outputs action** is the key unlock:
```yaml
- uses: yaffle-dev/outputs-action@v1
  id: infra
  with:
    workspace: my-app/infra
    
- run: deploy-my-app --database-url=${{ steps.infra.outputs.database_url }}
```

Your code deploys onto the preview infrastructure. Test the whole thing.

---

## The Expansion: Everything as a Product

Once we're in the door with preview environments, we expand to the full vision:

### Phase 1: Preview Your System (The Wedge)
- Preview environments for PRs (infra + code together)
- Outputs action bridges infra and code deploys
- Test the whole thing before merge

### Phase 2: Beyond Infrastructure
- Dashboards are a product - preview them
- Feature flags are a product - preview them
- Policies are a product - preview them
- Anything that can break production should be previewable

### Phase 3: Platform as Product
- Platform team publishes versioned offerings
- Tiered stability (platinum/gold/bronze)
- Typed contracts with explicit snapshot provenance
- Product teams consume through self-service

### Phase 4: Safe Change Management for Everything
- Humans and agents making changes
- All changes go through preview
- Promotion through environments (preview → staging → production)
- Audit trail, rollback, the works

**Key insight**: Each phase builds on the last. You can't sell Phase 3 to
someone who hasn't felt the pain of Phase 1.

---

## Competitive Positioning

### We're NOT Competing With:

| Tool | Why Not Direct Competition |
|------|---------------------------|
| Vercel/Netlify | They preview code. We preview infra. **Together we're complete.** |
| Terraform Cloud | They manage state and run plans. We do previews. We're TFC-compatible. |
| Atlantis | OSS plan runner. We're a superset - actual preview environments. |

### We ARE Competing With:

| Competitor | Our Advantage |
|------------|---------------|
| "Shared staging environment" | Isolated, PR-specific state |
| "Deploy and hope" | Test before production |
| "Plan output is good enough" | Actually create the infra and test on it |
| Internal tooling | We're a product, not a side project |

### Potential Partners/Integrations

- **Vercel/Netlify**: Our infra previews + their code previews = full system preview
- **Terraform Cloud**: We're TFC-compatible. Migration path, not replacement.
- **GitHub**: Deep integration, PR-centric workflow

---

## Alternative Framings (For Reference)

These are other ways we COULD position, but aren't the recommended wedge:

### "Terraform Cloud Alternative"

**Risk**: Competing on price is a race to the bottom. Defines us by competitor.

**Verdict**: TFC compatibility is a FEATURE that eases migration, not the positioning.

### "BYOA / Self-Hosted"

**Risk**: Long sales cycles, support burden, enterprise motion required.

**Verdict**: This is an EXPANSION path for larger deals, not the wedge.

### "Platform Engineering Platform"

**Risk**: Too abstract, long sales cycles, requires mature buyer.

**Verdict**: This is the VISION. Sell the wedge, deliver the vision over time.

---

## Product Decisions Through This Lens

### What Supports the Wedge (Build Now)

| Feature | Why |
|---------|-----|
| Preview environments | **Core value prop** - isolated infra per PR |
| Outputs action | **The bridge** - lets code deploy onto preview infra |
| GitHub integration | PR-centric workflow, where teams already work |
| PR comments | Surface results, make previews visible |
| Basic state management | Required for previews to work |

### What Supports Expansion (Build Later)

| Feature | Phase | Why |
|---------|-------|-----|
| TFC-compatible API | Phase 1-2 | Eases adoption for existing TF users |
| Dashboard/config previews | Phase 2 | Extend beyond infra |
| Module registry | Phase 3 | Platform-as-product enabler |
| Tiered workspaces | Phase 3 | Stability tiers for platform teams |
| BYOA deployment | Phase 4 | Customer-account isolation |

### What We've Built - Validation Check

| Feature | Wedge Support | Verdict |
|---------|---------------|---------|
| TFC-compatible state backend | Enables `tofu` workflow | Good - supports adoption |
| Outputs action | **Critical** - bridges infra→code | Good - this is key |
| Preview workspace lifecycle | Core to the wedge | Good |
| Module registry | Phase 3 (but we need it now) | Good - dogfooding |

**On the module registry**: This might look like a Phase 3 feature built too early,
but we need it internally. We're setting up foundational infra (VPCs, networking,
databases) that our product workspaces will consume. We're the first customer.

This is the dogfooding principle from AGENTS.md in action: if we need it to build
Yaffle, it's not premature - it's validated by our own usage.

---

## Validation Checklist

Before we commit fully to this positioning, validate:

- [ ] Talk to 5-10 engineering/platform leads at target companies
- [ ] Confirm "can't preview infra + code together" is a real, painful problem
- [ ] Understand current workarounds (staging? YOLO? manual sequencing?)
- [ ] Test messaging: does "preview your whole system" land?
- [ ] Identify what they'd pay (anchor on current tooling spend + outage cost)
- [ ] Understand buying process (swipe card vs procurement)
- [ ] Validate AI/agent angle - is this a real accelerant or hype?

### Discovery Questions

**About the problem:**
- "Tell me about the last time a deploy broke production"
- "How do you test changes before they hit production?"
- "Do you have a staging environment? How well does it match production?"
- "How do infrastructure changes and code changes get coordinated?"

**About the pain:**
- "What's the scariest part of shipping changes?"
- "How much time do you spend debugging prod issues vs preventing them?"
- "Has an AI agent ever shipped a change that broke something?"

**About solutions:**
- "How do you evaluate new dev tools?"
- "What would make you switch from your current workflow?"
- "If you could wave a magic wand, what would change?"

---

## Pricing Implications

With "preview your whole system" as the wedge, pricing should anchor on:

1. **Value of preventing outages** - What does an outage cost them?
2. **Existing tool spend** - Vercel, TFC, Spacelift, staging infra costs
3. **Change velocity** - More deploys = more value from previews

**Possible models**:
- Per-preview-environment (pay for what you use)
- Per-workspace (simpler, predictable)
- Per-seat (aligns with team size)
- Usage-based hybrid (base + overages)

**Free tier is critical** - product-led motion requires self-serve trial.

**To validate**: What metric resonates? What do similar tools charge?

---

## Go-to-Market Implications

### Channel

- **Content**: "Why your staging environment is lying to you" - problem-focused
- **Community**: DevOps, SRE, platform engineering communities
- **Integrations**: Vercel/Netlify ecosystem (we complete their story)
- **Outbound**: Companies with recent public outages

### Motion

- **Product-led**: Self-serve signup, free tier, expand when valuable
- **Bottom-up**: Individual teams adopt, expand to org
- **Sales-assisted**: For larger deals, help with rollout

### Messaging

**Lead with the insight:**
- "Infrastructure and code aren't separate. Preview them together."
- "Preview your whole system, not just your code."
- "Your staging environment is lying to you."

**Not:**
- "Infrastructure as a Product platform" (too abstract, Phase 3)
- "TFC alternative" (defines us by competitor)
- "Platform engineering solution" (too niche, Phase 3)
- "Terraform automation" (too narrow, we're beyond TF)

---

## The AI/Agent Angle

This might be the "why now" that makes everything urgent.

### The Shift

- AI agents (Cursor, Copilot, Claude, etc.) are writing more code
- They're also writing infrastructure (Terraform, configs)
- Change velocity is 10x what it was
- Humans can't review everything anymore

### The Problem This Creates

- More changes = more risk
- Agents don't have production context
- Agents make plausible-looking mistakes
- "Review every PR" doesn't scale

### Why Yaffle Matters More

Preview environments become a **safety mechanism for agent-driven development**:

1. Agent makes a change (code, infra, whatever)
2. Preview spins up automatically
3. Tests run against the preview
4. Human reviews results, not code
5. Safe to merge

**The insight**: You don't review agent code line-by-line. You validate the outcome.

Preview environments are how you validate outcomes.

### Messaging Angle

- "Safe deployments for the age of AI agents"
- "When agents write your infra, you need previews"
- "Review results, not code"

**To validate**: Is this resonating with teams adopting AI coding tools? Or is it hype?

---

## Open Questions

1. Do we have access to potential buyers for customer discovery?
2. What's our runway? (Affects how much validation we can do)
3. Are we open to pivoting if discovery invalidates our assumptions?
4. Who on the team does customer discovery? (Founder should do first 10)
5. Is the AI/agent angle a real accelerant or just hype?

---

## Appendix: Competitive Landscape

### Infrastructure Tools

| Tool | What They Do | Gap |
|------|--------------|-----|
| Terraform Cloud | State, plans, runs | Plans only, no actual preview |
| Spacelift | GitOps, policy | Plans only, no actual preview |
| Env0 | Cost estimation | Plans only, no actual preview |
| Atlantis | OSS plan runner | Plans only, no state management |
| Pulumi Cloud | State, deployments | Different paradigm, same gap |

### Code Preview Tools

| Tool | What They Do | Gap |
|------|--------------|-----|
| Vercel | Frontend previews | No infrastructure |
| Netlify | Frontend previews | No infrastructure |
| Railway | Backend previews | Limited infra, their infra only |
| Render | Backend previews | Limited infra, their infra only |

### Staging/Environments

| Approach | What It Is | Gap |
|----------|------------|-----|
| Shared staging | One env for all | Contention, drift, not PR-specific |
| Namespace per PR | K8s namespaces | Limited to K8s, no cloud infra |
| Feature branches | Long-lived branches | Merge conflicts, drift |

**The gap**: Nobody previews infrastructure AND code together in an isolated,
PR-specific environment. That's the wedge.

### Potential Allies

| Tool | Why Partner |
|------|-------------|
| Vercel | Our infra previews + their code previews = complete story |
| Netlify | Same as Vercel |
| GitHub | Deep integration opportunity |
| OpenTofu | Aligned on open ecosystem |
