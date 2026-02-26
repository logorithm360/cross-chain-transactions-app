# AutoPilot DCA Workflow (Feature 2)

This is the dedicated CRE workflow for Feature 2 (`AutoPilot DCA`).

## Implemented behavior
1. Trigger modes:
   - HTTP trigger (on-demand request)
   - Cron trigger (scheduled upkeep candidate)
2. Mandatory cross-cutting integrations:
   - Feature 6 security checks (local policy + on-chain mode/token status)
   - Feature 5 record writes (`UserRecordRegistry.appendRecord`)
3. Execution modes:
   - `CREATE_ORDER`: calls `AutomatedTrader.createTimedOrder(...)`
   - `RUN_UPKEEP`: calls `AutomatedTrader.checkUpkeep("")`, then `performUpkeep(performData)` if needed

## Files
1. `transaction-workflow/autopilot.ts`
2. `transaction-workflow/autopilot.types.ts`
3. `transaction-workflow/autopilot.gemini.ts`
4. `transaction-workflow/autopilot.notifications.ts`
5. `transaction-workflow/config.autopilot.staging.json`
6. `transaction-workflow/config.autopilot.production.json`
7. `transaction-workflow/workflow.yaml` target keys:
   - `autopilot-staging-settings`
   - `autopilot-production-settings`
8. `project.yaml` target keys:
   - `autopilot-staging-settings`
   - `autopilot-production-settings`

## Required address wiring
Fill in these before real execution:
1. `automatedTraderByChainId["11155111"]`
2. `securityManagerContract`
3. `tokenVerifierContract`
4. `userRecordRegistryContract`
5. `cronRequest.receiverContract` (destination programmable receiver)
6. `cronRequest.user` and `cronRequest.recipient`
7. Optional: `authorizedEVMAddresses` for deployed HTTP trigger auth

Safety defaults:
1. `allowCreateOrderFromWorkflow=false`
2. `allowPerformUpkeepFromWorkflow=false`
3. `geminiFailurePolicy=SKIP` in production
4. `geminiApiKey=""` in committed config files (use secrets/env)

The workflow will never call owner/forwarder-protected execution paths unless you explicitly enable those flags.

## HTTP payload example
```json
{
  "walletChainId": 11155111,
  "destinationChainId": 80002,
  "serviceType": "DCA",
  "executionMode": "RUN_UPKEEP",
  "user": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
  "token": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  "amount": "100000000000000000",
  "recipient": "0xb3CcDfCC821fC7693e0CbF4b352f7Ca51b33c89B",
  "receiverContract": "0x7541cEB8A6db4E8C8a58092e186f9d8ABEDC7Ef2",
  "action": "transfer",
  "cadenceSeconds": 60,
  "recurring": true,
  "maxExecutions": 0,
  "deadline": 0
}
```

## Simulate (non-interactive)
```bash
cre workflow simulate transaction-workflow \
  -T autopilot-staging-settings \
  --non-interactive \
  --trigger-index 1 \
  --http-payload @/tmp/autopilot-request.json
```

`trigger-index` mapping:
1. `0` = cron
2. `1` = http

## Cron simulation
```bash
cre workflow simulate transaction-workflow \
  -T autopilot-staging-settings \
  --non-interactive \
  --trigger-index 0
```

## Expected result signals
1. `security.enforcementMode` + `security.allow` reflect Feature 6.
2. `execution.submitted=true` when write call is sent.
3. `status` transitions:
   - `READY`: executable and allowed
   - `BLOCKED`: policy or resolver block
   - `DEGRADED`: partial configuration (no state-changing write)
4. Structured ops logs (when `emitStructuredLogs=true`):
   - `request_received`
   - `ai_fallback_applied`
   - `workflow_outcome`

## Preflight (required before live run)
```bash
./transaction-workflow/scripts/preflight-autopilot.sh staging
./transaction-workflow/scripts/preflight-autopilot.sh production
```

## Production gate
Use:
- `transaction-workflow/AUTOPILOT-PRODUCTION-CHECKLIST.md`
