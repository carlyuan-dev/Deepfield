# Batch company research — approved design

User approved implementation on 2026-09-17. Only batch research and company-list operation progress are in scope; preserve unrelated dirty changes and historical reports. No commit/push requested.

## User flow

Place 批量调研公司 immediately right of 一键导入公司. Three-step wizard: select current topic companies (select all/clear, count); enter shared direction/focusScope/asOfDate using existing research fields; review only selected company names with 编辑 buttons (no per-row field summaries). Editing reuses CompanyResearchModal, prefilled with latest company input, all three fields editable, submit 确认修改 saves draft only. Successfully saved overrides show 已修改 immediately left of 编辑. Back navigation preserves selection and overrides for retained companies; changed common defaults affect only unmodified entries. No report/queue creation until 开始调研. Only ready/identity-resolved companies selectable; explain disabled options.

## Execution

Durable single global batch with ordered entries and input snapshots. Per company invoke existing CompanyResearchService raw then structure end-to-end; do not duplicate agents/prompts/harness or history. Create a new report version only when that entry actually starts. One company failure is terminal for that entry and continues next; structure failure retains raw and existing single-stage retry. Public configuration/authentication failures pause whole batch; no blind retry loops. Switching views does not stop processing. Restart recovers persisted batch as paused, never auto-runs paid work; continue explicitly reuses raw stage when available and existing retry semantics. Refuse competing manual research while a batch reserves research execution, including between entries.

Batch priority over background profile enrichment at job boundaries: let active profile completion finish; start no more profile jobs while batch runs; resume background profile queue after batch finishes/cancels. Do not interrupt Chat. If research is already occupied refuse batch start with clear conflict. First version one active/paused batch globally; no append/multiple batches.

## Cancellation

Status row has understated gray underlined 取消批量调研 with hover highlight. Atomically mark cancelling before awaiting anything; no subsequent entry may start. Cancel current owned run via existing single-research cancellation (removes unfinished report), never delete already terminal reports or prior versions. Clear waiting entries without report creation. Completion racing cancellation wins if already persisted terminal; preserve it. Wait for cancellation acknowledgement before releasing batch reservation/background enrichment. Double cancel idempotent. Cancel paused/recovered batch clears remaining work and removes only its unfinished owned run, not existing completed/failed reports.

## Progress and row UI

Under topic heading, left of 添加公司 and above 当前公司, unboxed inline text + accessible progress bar with completed/total label inside + spinner while genuinely active. Text 正在自动补全公司信息 or 正在批量进行公司调研. Batch progress counts terminal processed entries including failures, not successful-only. Show failure count separately. Waiting for active profile: 等待当前公司资料补全完成; paused no loading spinner and clear cause/continue/settings action. Finished no spinner, counts success/failure. Selected topic only (do not show other topic counters as local work). Profile progress counts current processing cohort for this topic, not all historical ready companies; reused global company identity remains intact.

Company rows preserve existing enrichment behavior. Batch pending shows 等待调研; active raw/structure shows spinner with stage label; batch processing must NOT disable company navigation. Report view reuses live single-company display. Responsive toolbar wraps without shrinking/stacking button text. Empty/idle progress unobtrusive.

## Verification

Focused automated tests: ordered two-stage completion, per-entry failure, configuration pause, restart pause/recovery, cancellation before dispatch/during raw/during structure/terminal race, no waiting records, manual conflict, enrichment boundary coordination. UI wizard back/default/override preservation, reused form no model call, status counts, cancellation and navigating active company. Test with deterministic fake workers; no real multi-company billable research without user request. Build/package app for user hand test using normal native launch only.
