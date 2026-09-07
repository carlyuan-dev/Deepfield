# Deepfield Implementation Roadmap

> **Roadmap status update (2026-09-07):** Plan 1 and the implemented Tool
> Platform remain the project baseline. The sequence below is the original
> roadmap; current delivery now follows the small, user-reviewed slices in
> `docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`.

**Current spec:** `docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`

**Historical source spec:** `docs/superpowers/specs/2026-08-25-deepfield-agent-native-research-design.md`

## Purpose

The approved design spans several independently reviewable subsystems. Implementing all of them from one monolithic plan would lock speculative interfaces too early. Work is therefore divided into six plans. Each plan must end with a runnable, testable vertical increment and a reviewed interface boundary before the next plan is written or executed.

## Plan sequence

### Plan 1: Foundation and Agent Shell

Deliver an Apple Silicon Electron development build that can:

- create an industry project directly from the Capability entry without invoking an LLM;
- create exactly one lazy project conversation;
- store projects, conversations, messages and activity events in SQLite;
- store the DeepSeek API key through macOS-backed encrypted storage;
- run Pi Agent Core in an Electron utility process;
- stream a pure Chat response into the Agent-native shell;
- switch between full Chat, direct Capability canvas and Capability canvas with a docked Chat rail.

Detailed plan: `docs/superpowers/plans/2026-08-25-deepfield-foundation-agent-shell.md`

### Plan 2: Tool Platform and Retrieval Benchmark

Deliver Pi-native `AgentTool` adapters backed by a shared versioned Tool Registry and Policy Runner with schema validation, permissions, budgets, retry, cancellation, audit events and test doubles. Direct backend callers and Pi Agents use the same definitions and executors. Implement safe HTTP/HTTPS fetching, ephemeral resource storage, HTML/PDF parsing and link checks. Then run the fixed humanoid-robot query benchmark through a unified SearchProvider contract and select the first `search_web` adapter from measured Chinese official-site coverage, core-company recall, link validity, noise and cost.

Exit criterion: the app can run a bounded retrieval probe through Tools, display its trace in developer mode and persist no full web page.

Detailed design: `docs/superpowers/specs/2026-08-27-deepfield-tool-platform-design.md`

### Plan 3: Capability Runtime and Agent Supervisor

Deliver Capability definitions, commands, durable runs/jobs, checkpoints, approval requests, artifact navigation, project event delivery, role definitions and the Agent Supervisor. Prove that direct UI and Chat launch the same Capability state; prove that a child Pi Agent receives only its scoped ToolSet and structured input.

Exit criterion: a synthetic multi-step Capability survives restart, waits for confirmation in either UI surface and completes through an isolated child Agent.

### Plan 4: Capability A Discovery and Company Research

Deliver project templates, global companies, project-company records, Discovery Agent, candidate deduplication, user selection, immutable batch snapshots, sequential Company Research Agents, EvidenceFragments, Claims, Citations and the pending-evidence path.

Exit criterion: a humanoid-robot project can discover companies, accept a human-filtered set and generate evidence-backed company reports without cross-company context leakage.

### Plan 5: Research Workspace and Maintenance

Deliver the fixed industry-summary region, independently scrolling company reports, citation hover/open behavior, editing and revisions, Summary Agent, FieldResearchJob, CompanyUpdateJob, SummaryRefreshJob, TemplateSyncJob and shared Chat/UI confirmations.

Exit criterion: the reporter can complete a full ResearchCycle, edit it, run a field-only follow-up and refresh the summary without reopening the completed cycle.

### Plan 6: Files, Word Export, Updates and Release Hardening

Deliver managed project attachments for PDF/DOCX/XLSX/text/images, local-file citations, Word summary export, schema backups/migrations, signed auto-update plumbing, cache retention, full regression suites, humanoid-robot blind acceptance, signing, notarization and the Apple Silicon DMG.

Exit criterion: a non-technical M3 Mac user can install, configure, research, restart, update and retain all data without development tools.

## Cross-plan rules

- Read the approved spec and every completed predecessor plan before writing the next plan.
- Preserve the boundaries in the user-provided diagrams under `docs/架构图/`.
- Never expose arbitrary shell, filesystem or network access to an Agent.
- Use test-driven development and commit each independently reviewable task.
- Do not start Capability B until all Capability A release gates pass.
- Do not parallelize company research in the first release.
- Treat the database as long-term memory and Agent transcripts as job-scoped working context.
- Generate evidence before Claims; never attach citations to prose generated from model memory.
