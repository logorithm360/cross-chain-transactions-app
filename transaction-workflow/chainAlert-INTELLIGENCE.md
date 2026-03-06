# chainAlert Intelligence Workflow

This workflow is additive to existing `autopilot`/`AutomatedTrader` execution paths.

## Files

- `chainAlert.intelligence.ts`
- `chainAlert.intelligence.types.ts`
- `chainAlert.openai.ts`
- `chainAlert.eval.portfolio.ts`
- `chainAlert.eval.token.ts`
- `chainAlert.eval.dca.ts`
- `chainAlert.eval.wallet.ts`
- `config.chainAlert.intelligence.staging.json`
- `config.chainAlert.intelligence.production.json`
- `secrets.chainAlert.intelligence.yaml`

## System Wiring

- Feature 5 (`UserRecordRegistry`) wiring:
  - Enabled via `feature5Enabled`
  - Contract map: `userRecordRegistryByChainId`
  - Trigger/resolve/evaluation outcomes append records on-chain.

- Feature 6 (`SecurityManager`/`TokenVerifier`) wiring:
  - Enabled via `feature6Enabled`
  - Contract map: `securityManagerByChainId`
  - High-severity/risk alert triggers log incidents on-chain.

## Secrets

Set environment variables (or `.env`) before simulation:

- `OPENAI_API_KEY_ALL`
- `ETHERSCAN_API_KEY_ALL`

## Targets

- `chainAlert-intelligence-staging-settings`
- `chainAlert-intelligence-production-settings`

## Simulate

```bash
cre workflow simulate transaction-workflow -T chainAlert-intelligence-staging-settings -e .env -v
```

## HTTP Actions

- `UPSERT_RULE`
- `ENABLE_RULE`
- `LIST_RULES`
- `RUN_EVALUATION_ONCE`

Example payload:

```json
{
  "action": "RUN_EVALUATION_ONCE",
  "payload": {
    "chainId": 11155111
  }
}
```
