# AutoPilot Production Checklist

This checklist closes the five blockers identified for production readiness.

## 1) AI decision reliability
- Requirement:
  - `decisionMode` is `GEMINI`.
  - `geminiFailurePolicy` is explicitly set.
  - Production must stay fail-closed (`securityEnforcementMode=ENFORCE` and `geminiFailurePolicy=SKIP`).
- Validation:
```bash
cre workflow simulate transaction-workflow -T autopilot-staging-settings -e .env -v
```
- Pass criteria:
  - On Gemini outage/quota, decision reason is deterministic (`GEMINI_*`) and workflow does not crash.
  - In production config, fallback does not auto-execute.

## 2) Toolchain/version alignment
- Requirement:
  - `cre` CLI must be `>= requiredCreCliVersion` from config.
- Validation:
```bash
./transaction-workflow/scripts/preflight-autopilot.sh staging
./transaction-workflow/scripts/preflight-autopilot.sh production
```
- Pass criteria:
  - Preflight reports `autopilot preflight passed`.

## 3) Secrets hygiene
- Requirement:
  - `geminiApiKey` in committed config files is empty.
  - Runtime key provided through secrets/env only.
- Validation:
```bash
rg -n '"geminiApiKey"' transaction-workflow/config.autopilot.*.json
```
- Pass criteria:
  - Both config files show `"geminiApiKey": ""`.

## 4) Observability and incident clarity
- Requirement:
  - `emitStructuredLogs=true`.
  - Workflow emits `[ops]` logs for request received, AI fallback, and final outcome.
- Validation:
```bash
cre workflow simulate transaction-workflow -T autopilot-staging-settings -e .env -v
```
- Pass criteria:
  - Logs contain structured events:
    - `request_received`
    - `ai_fallback_applied` (when relevant)
    - `workflow_outcome`

## 5) End-to-end production validation matrix
- Execute:
1. Positive path: allowlisted token, security allow, decision execute.
2. Security blocked path: blocklisted token in ENFORCE.
3. Gemini unavailable path: quota/auth failure.
4. No executable upkeep path: `checkUpkeep=false`.
5. Feature 5 write path: record append succeeds.
- Pass criteria:
  - Each path returns deterministic `reasonCode`.
  - No unexpected reverts.
  - Outcome and notification messages remain consistent with action taken.

## Final go-live gate
- All checklist items pass.
- Secrets rotated and stored outside repo.
- `cre version` confirmed at required level or above.
