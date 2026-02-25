# ChainShield Workflow (Feature Start)

This file documents the first executable ChainShield CRE workflow scaffold.

## What is implemented now
- Dedicated workflow entry: `transaction-workflow/chainshield.ts`
- HTTP request pipeline with 5 stages:
1. Resolver (`resolveExecutionConfig`)
2. Preflight report generation
3. Feature 6 security decision (`runSecurityChecks` + on-chain state reads)
4. Execution adapter (`executeServiceAction`) with CRE EVM write capability
5. Feature 5 record emission (response model + on-chain appends)
- Deterministic response model with states:
1. `READY`
2. `BLOCKED`
3. `DEGRADED`
- Deterministic request ID derived from payload bytes (DON-safe consensus behavior)
- HTTP trigger auth support via `authorizedEVMAddresses` (required for deployment)
- On-chain reads:
1. `SecurityManager.getSystemHealth()`
2. `TokenVerifier.getStatus(token)`
- On-chain writes:
1. Sender contract call via `EVMClient.writeReport(...)`
2. `UserRecordRegistry.appendRecord(...)` via `EVMClient.writeReport(...)`
- Strict-mode fail-closed behavior in ENFORCE mode for `SECURITY_BLOCKED:*` decisions

## Current limitations
- Destination chain completion monitoring is still external (CCIP Explorer / receiver queries); callback ingestion is not yet auto-wired in this workflow.
- Not all service types are deployed on every configured chain pair; unresolved routes degrade/block at resolver stage.

## Config files
- `transaction-workflow/config.chainshield.staging.json`
- `transaction-workflow/config.chainshield.production.json`

Fill these before deployment:
- `authorizedEVMAddresses` (must contain real EVM addresses for deployed HTTP triggers)
- `sourceSenderByChainId`
- `destinationReceiverByChainId`
- `securityManagerContract`
- `tokenVerifierContract`
- `userRecordRegistryContract`

## Run targets
Use workflow settings:
- `chainshield-staging-settings`
- `chainshield-production-settings`

## Expected request payload
```json
{
  "walletChainId": 11155111,
  "destinationChainId": 80002,
  "serviceType": "CHAINSHIELD_TRANSFER",
  "user": "0x0000000000000000000000000000000000000001",
  "recipient": "0x0000000000000000000000000000000000000002",
  "token": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  "amount": "100000000000000000",
  "action": "transfer"
}
```

## Next implementation step
Add destination delivery callback ingestion to automatically append `DESTINATION_RECEIVED` / `FINAL_OUTCOME` phases in the registry.
