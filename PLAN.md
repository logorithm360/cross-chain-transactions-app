# ChainAlert Intelligence — Implementation Plan

## Scope
Categories A (Portfolio Health) and C (DCA Order Monitoring) only.
AI Provider: OpenAI (matches existing crossvault pattern).
State Storage: Hybrid (on-chain registry for rules/history, CRE workflow storage for cycle state).

---

## Phase 1 — Solidity Contract: `ChainAlertRegistry.sol`

**File:** `contracts/src/ChainAlertRegistry.sol`

On-chain registry that stores user-defined alert rules and fired alert history. Follows the same patterns as `ChainRegistry.sol` and `UserRecordRegistry.sol`.

### Data Structures
```
AlertRuleType enum:
  PORTFOLIO_DROP_PERCENT, PORTFOLIO_DROP_ABSOLUTE, TOKEN_CONCENTRATION,
  DCA_ORDER_FAILED, DCA_LOW_FUNDS, DCA_ORDER_PAUSED_BY_AI, DCA_EXECUTION_STUCK

AlertSeverity enum: INFO, WARNING, CRITICAL

AlertRule struct:
  ruleId (uint256), user (address), ruleType (AlertRuleType),
  thresholdBps (uint256), thresholdAbsolute (uint256),
  monitoredChainSelector (uint64), monitoredContract (address),
  monitoredOrderIds (uint256[]), cooldownSeconds (uint256),
  isActive (bool), createdAt (uint256)

FiredAlertRecord struct:
  alertId (uint256), ruleId (uint256), user (address),
  ruleType (AlertRuleType), severity (AlertSeverity),
  triggerValue (uint256), baselineValue (uint256),
  aiHeadline (string), aiExplanation (string),
  timestamp (uint256)
```

### Functions
- `createRule(AlertRule calldata)` — owner/user creates a monitoring rule
- `pauseRule(uint256 ruleId)` — pauses a rule
- `deleteRule(uint256 ruleId)` — deactivates a rule
- `getActiveRules(address user)` — returns all active rules for a user
- `getRule(uint256 ruleId)` — returns a single rule
- `recordAlert(FiredAlertRecord calldata)` — workflow writes fired alert on-chain (onlyWorkflow)
- `getAlertHistory(address user, uint256 offset, uint256 limit)` — paginated alert history
- `setWorkflowAddress(address)` — owner sets the CRE workflow address

### Interface
- `contracts/src/interfaces/IChainAlertRegistry.sol` — interface extracted for workflow reads

### Test
- `contracts/test/ChainAlertRegistry.t.sol` — Foundry tests covering create/pause/delete/record/history

---

## Phase 2 — TypeScript Types: `chainalert.types.ts`

**File:** `transaction-workflow/chainalert.types.ts`

Follows exact pattern of `autopilot.types.ts` and `crossvault.types.ts`.

### Types defined:
- `AlertRuleType` — discriminated union of all rule types
- `AlertSeverity` — "INFO" | "WARNING" | "CRITICAL"
- `AlertRuleState` — state machine per rule: "WATCHING" | "TRIGGERED" | "COOLING_DOWN"
- `AlertRuleConfig` — user rule params (thresholds, cooldown, target orders/chains)
- `PortfolioSnapshot` — per-chain, per-token value breakdown
- `DCAOrderSnapshot` — mirrors AutomatedTrader.OrderSnapshot
- `FiredAlert` — rule that crossed threshold, includes rule details + current/baseline values
- `AIAlertAnalysis` — OpenAI response: severity, headline, explanation, likelyCause, recommendedActions, isLikelyNoise
- `ChainAlertConfig` — workflow config (schedule, chain resolver, contracts, AI model, monitored users, security settings)
- `ChainAlertOutcome` — full workflow response matching pattern of AutoPilotOutcome
- `CycleState` — ephemeral state stored in CRE storage (baselines, last-seen values, cooldowns)

---

## Phase 3 — Data Collectors

### 3a. `chainalert.portfolio.ts` — Portfolio Data Collector
- Reads token balances from AutomatedTrader contracts across configured chains using `EVMClient.callContract`
- Reads Chainlink Data Feed prices using `AggregatorV3Interface.latestRoundData()`
- Calculates USD portfolio value per chain
- Returns `PortfolioSnapshot`
- Uses same `encodeCallMsg` + `decodeFunctionResult` patterns as autopilot.ts

### 3b. `chainalert.dca.ts` — DCA Order Monitor
- Calls `getUserOrders(address)` on AutomatedTrader to get `OrderSnapshot[]`
- For each order: checks `dcaStatus`, `executionsRemainingFunded`, `lastFailedMessageIds`, `lastPendingMessageIds`
- Compares against stored cycle state to detect NEW failures (not previously seen)
- Returns `DCAOrderSnapshot[]` with change flags

---

## Phase 4 — Rule Evaluation Engine

### 4a. `chainalert.engine.ts` — Rule Evaluator + State Manager
- Loads user rules from ChainAlertRegistry (on-chain read)
- Loads cycle state from CRE persistent storage (key-value)
- For each rule, runs `shouldTrigger()`:
  - **PORTFOLIO_DROP_PERCENT**: `currentValue < baseline * (1 - thresholdBps/10000)`
  - **PORTFOLIO_DROP_ABSOLUTE**: `currentValue < baselineValue - thresholdAbsolute`
  - **TOKEN_CONCENTRATION**: `singleTokenPct > thresholdBps/10000`
  - **DCA_ORDER_FAILED**: new non-zero entry in `lastFailedMessageIds`
  - **DCA_LOW_FUNDS**: `executionsRemainingFunded < threshold`
  - **DCA_ORDER_PAUSED_BY_AI**: `dcaStatus == PAUSED_BY_WORKFLOW`
  - **DCA_EXECUTION_STUCK**: pending message age > threshold hours
- Implements deduplication state machine:
  - WATCHING -> (condition met) -> TRIGGERED -> (alert sent) -> COOLING_DOWN
  - COOLING_DOWN -> (cooldown expired + condition still met) -> TRIGGERED
  - COOLING_DOWN -> (condition no longer met) -> WATCHING
- Updates cycle state after evaluation
- Returns `FiredAlert[]`

---

## Phase 5 — AI Analysis Layer

### `chainalert.ai.ts` — OpenAI Alert Analyzer
- Follows exact pattern of `crossvault.gemini.ts` (OpenAI Chat Completions API)
- Uses `runtime.runInNodeMode()` with `consensusIdenticalAggregation<>()`
- Secret: `OPENAI_API_KEY` (same as crossvault)
- Prompt template builds context from FiredAlert + portfolio/DCA snapshots
- Response schema: `{ severity, headline, explanation, likelyCause, recommendedActions[], isLikelyNoise, noiseReason }`
- Noise filter: if `isLikelyNoise === true`, downgrade severity to INFO
- Fallback on AI failure: return severity=WARNING with generic message (don't suppress alerts)

---

## Phase 6 — Notifications

### `chainalert.notifications.ts`
- `buildAlertNotification(alert, analysis)` — human-readable alert message
- `buildCycleReport(cycleId, alertCount, suppressedCount)` — cycle summary
- Severity-based formatting: CRITICAL = brief + urgent, INFO = detailed

---

## Phase 7 — Workflow Assembly

### `chainalert.ts` — Main Workflow Entry Point
- Follows exact pattern of `autopilot.ts` and `crossvault.ts`
- `Runner.newRunner<ChainAlertConfig>()`
- Two triggers:
  1. **Cron** (`*/15 * * * *`) — full monitoring cycle
  2. **HTTP** — on-demand rule management and status checks

### Cron handler (`onCronChainAlert`):
1. Read all active rules from ChainAlertRegistry (on-chain)
2. Collect portfolio snapshots (parallel per chain)
3. Collect DCA order snapshots
4. Load cycle state from CRE storage
5. Run rule evaluator -> `FiredAlert[]`
6. For each fired alert: call OpenAI for analysis
7. Update cycle state in CRE storage
8. Write fired alerts to ChainAlertRegistry on-chain (audit trail)
9. Append records to UserRecordRegistry (feature 5)
10. Build and log notifications

### HTTP handler (`onHttpChainAlert`):
- Accepts requests for: CREATE_RULE, PAUSE_RULE, DELETE_RULE, GET_STATUS, FORCE_CHECK
- CREATE_RULE writes to ChainAlertRegistry on-chain
- GET_STATUS returns current cycle state + active rules

---

## Phase 8 — Configuration

### `config.chainalert.staging.json`
- Same structure pattern as `config.autopilot.staging.json`
- Schedule: `*/15 * * * *`
- Chain resolver config (same 5 chains)
- Contract addresses: ChainAlertRegistry, AutomatedTrader(s), SecurityManager, TokenVerifier, UserRecordRegistry
- OpenAI model: `gpt-4o-mini`
- Monitored users list
- Default cooldown: 3600 (1 hour)
- Portfolio baseline mode: "24h_high"

### `workflow.yaml` additions
- `chainalert-staging-settings` and `chainalert-production-settings` targets

### `secrets.yaml` — already has `OPENAI_API_KEY` configured

---

## Phase 9 — Foundry Tests for ChainAlertRegistry

### `contracts/test/ChainAlertRegistry.t.sol`
- Test createRule with all 7 rule types
- Test pauseRule and deleteRule
- Test recordAlert (onlyWorkflow modifier)
- Test getAlertHistory pagination
- Test unauthorized access reverts
- Test rule lifecycle (create -> pause -> reactivate)

---

## Phase 10 — Integration Testing

### End-to-end workflow test:
1. Deploy ChainAlertRegistry to local/testnet
2. Create sample alert rules (portfolio drop 15%, DCA failure)
3. Run workflow build: `cre-cli build`
4. Execute cron cycle via HTTP trigger
5. Verify:
   - Portfolio data collected correctly
   - DCA order status read correctly
   - Rule evaluation produces correct triggers
   - OpenAI called only for triggered rules
   - Alert records written on-chain
   - Notifications logged

---

## File Summary (new files to create)

| File | Description |
|------|-------------|
| `contracts/src/ChainAlertRegistry.sol` | On-chain alert rules + history |
| `contracts/src/interfaces/IChainAlertRegistry.sol` | Interface for workflow reads |
| `contracts/test/ChainAlertRegistry.t.sol` | Foundry tests |
| `transaction-workflow/chainalert.types.ts` | TypeScript type definitions |
| `transaction-workflow/chainalert.portfolio.ts` | Portfolio data collector |
| `transaction-workflow/chainalert.dca.ts` | DCA order monitor |
| `transaction-workflow/chainalert.engine.ts` | Rule evaluator + state manager |
| `transaction-workflow/chainalert.ai.ts` | OpenAI alert analyzer |
| `transaction-workflow/chainalert.notifications.ts` | Notification builder |
| `transaction-workflow/chainalert.ts` | Main workflow entry point |
| `transaction-workflow/config.chainalert.staging.json` | Staging config |

| File | Description |
|------|-------------|
| `transaction-workflow/workflow.yaml` | Add chainalert targets (edit) |

---

## Build Order (Dependencies)

```
Phase 1 (ChainAlertRegistry.sol + interface + test)
  ↓
Phase 2 (chainalert.types.ts) — depends on contract ABI knowledge
  ↓
Phase 3a, 3b (data collectors) — depend on types, can be parallel
  ↓
Phase 4 (engine) — depends on types + collectors
  ↓
Phase 5 (AI layer) — depends on types
  ↓
Phase 6 (notifications) — depends on types
  ↓
Phase 7 (workflow assembly) — depends on all above
  ↓
Phase 8 (config + workflow.yaml) — depends on workflow
  ↓
Phase 9 (Foundry tests) — can run after Phase 1
  ↓
Phase 10 (integration) — final
```
