# Deepfield Capability A Company List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver persistent industry-research items, company list/detail workflows, safe CRUD, and resumable long-text company recognition.

**Architecture:** `CapabilityItem` remains independent from Conversation. Persistence owns global companies and item memberships; Application owns transactions and safe errors; Main owns DeepSeek; Renderer owns three-level Capability navigation, modal CRUD, chunk sequencing, progress and retry state.

**Tech Stack:** Electron, React, TypeScript, TypeBox, node:sqlite, Playwright, DeepSeek Chat Completions

**Spec:** `docs/superpowers/specs/2026-09-08-deepfield-capability-a-company-list-design.md`

## Global Constraints

- Preserve Conversation, messages and Tool audit when items are deleted.
- Removing companies or industries deletes newly orphaned companies in the same transaction; still-referenced companies remain reusable.
- Recognition chunks are at most 4000 code points; total input is at most 48000.
- Renderer calls recognition chunks sequentially and resumes at the failed chunk without repeating successful chunks.
- Main Agent does not yet invoke Capability services or inject Capability data into prompts.
- API keys remain in Main; automated UI checks use Fake Agent/Fake recognizer only.
- Keep all P4 changes uncommitted through user testing.

---

### Task 1: Persistence and application contracts

- [x] Replace legacy Project storage with `CapabilityItem`, global Company and item-company membership repositories.
- [x] Add create/get/list/update/idempotent delete item operations with newest-first listing.
- [x] Add deduplicated transactional add/remove/batch-remove membership operations.
- [x] Preserve Conversation, messages, Tool audit and still-referenced companies on item deletion.
- [x] Delete selected industries through one batch API and one SQLite transaction, rolling back all item and orphan-company deletion on failure.

### Task 2: Main, IPC and preload

- [x] Add strict item/company schemas and narrow Desktop API methods for CRUD, batch removal and recognition.
- [x] Validate IPC inputs and map provider/database failures to fixed safe errors.
- [x] Send one exact bounded chunk per DeepSeek JSON-object request without silent slicing.
- [x] Raise recognition output budget to 2048 tokens and give recognition a dedicated 20-second timeout while keeping ordinary requests at 7 seconds.

### Task 3: Renderer Capability workflow

- [x] Implement item list → company list → company detail navigation inside Capability.
- [x] Add create/edit industry modals and list-level delete confirmation with immediate local updates.
- [x] Replace the aggregate company manager with independent add, single-remove and page-level batch-remove flows.
- [x] Add accessible confirmation dialogs, danger styling, disabled processing states and recoverable errors.
- [x] Keep industry create/edit/delete on the industry list; use list-level deletion selection and a second confirmation.
- [x] Keep company detail factual and limited to stored fields plus the next-stage placeholder.

### Task 4: Resumable long-text import

- [x] Export the paragraph-aware 4000/48000 code-point chunker for Renderer use.
- [x] Process chunks sequentially with progress, cross-chunk normalized-name deduplication and incremental candidates.
- [x] Stop on failure, retain successful candidates and source text, disable incomplete import, and resume at the failed chunk.
- [x] Hide chunk counts, positions and resume cursors behind generic recognition progress and retry copy.
- [x] Invalidate recognition runs on source changes or modal closure so no next chunk or unmounted update occurs.

### Task 5: Final user-test checkpoint

- [x] Keep one readable Renderer main path for item/company CRUD and one for chunk retry.
- [x] Update the single Electron E2E main path for Enter/Shift+Enter, final Capability CRUD, details, confirmations and Fake import.
- [x] Run one typecheck and one E2E (the E2E performs its own build).
- [x] Reuse `out` for one arm64 directory package and run that app once with Fake mode and isolated userData.
- [x] Capture and inspect company-list, company-detail, batch-selection and completed Fake-candidate screenshots.
