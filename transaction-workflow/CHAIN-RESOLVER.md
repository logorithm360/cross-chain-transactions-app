# Feature 7: Chain Resolver (On-Chain Registry + CRE Runtime)

## Summary
Feature 7 introduces a global chain resolver that removes runtime hardcoding of chain, lane, token, and service-contract parameters.

The resolver is implemented as:
- An on-chain source of truth: `contracts/src/ChainRegistry.sol`
- A shared CRE runtime resolver: `transaction-workflow/chain-resolver.ts`
- Dual-mode enforcement in sender/trader contracts: `DISABLED`, `MONITOR`, `ENFORCE`

This keeps existing flows operational during migration while enabling production-grade registry-driven routing.

Initial network set:
- Ethereum Sepolia
- Polygon Amoy
- Arbitrum Sepolia
- Base Sepolia
- OP Sepolia

---

## 1. Problem and Objective
Before Feature 7, runtime logic depended on hardcoded per-chain configuration objects (selectors, lanes, bindings). That is fragile as chain coverage expands and deployments evolve.

Feature 7 objective:
- Make chain/lane/token/service binding resolution deterministic and centralized.
- Keep compatibility with existing allowlists during migration.
- Move runtime decisions to registry-backed checks, then enforce.

---

## 2. High-Level Architecture
```text
User/Cron Request
     |
     v
ChainShield / AutoPilot workflow
     |
     v
transaction-workflow/chain-resolver.ts
  - load chain meta
  - validate lane
  - validate token mapping
  - resolve service contracts
     |
     v
contracts/src/ChainRegistry.sol (source of truth)
     |
     v
ResolvedExecutionConfig + PreflightReport
     |
     v
Feature 6 security gate (existing)
     |
     v
State-changing execution in sender/trader contracts
  - additional on-chain resolver checks (mode-based)
```

Data domains managed by registry:
- Chain metadata
- Lane activation and fee mode
- Token transferability per lane
- Service contract bindings by `chainSelector + serviceKey`

---

## 3. On-Chain Components

### 3.1 Interface
File: `contracts/src/interfaces/IChainRegistry.sol`

Main structs:
- `ChainRecord`
- `LaneRecord`
- `LaneTokenRecord`
- `ServiceBinding`

Read API:
- `isChainSupported(uint64)`
- `getChainBySelector(uint64)`
- `getSelectorByChainId(uint256)`
- `isLaneActive(uint64,uint64)`
- `getLane(uint64,uint64)`
- `resolveLaneToken(uint64,uint64,address)`
- `isTokenTransferable(uint64,uint64,address)`
- `getServiceContract(uint64,bytes32)`
- `getSupportedChains(uint256,uint256)`
- `getActiveLanes(uint256,uint256)`

Write API (owner):
- `upsertChain`
- `setLane`
- `setLaneToken`
- `setServiceContract`
- `setChainActive`
- `setLaneActive`
- `setLaneTokenActive`
- `setServiceActive`

### 3.2 Registry Contract
File: `contracts/src/ChainRegistry.sol`

Implementation details:
- Owner-managed writes (`Ownable`)
- Deterministic keyed mappings:
  - chain by selector
  - selector by chainId
  - lane by `(source,destination)`
  - lane-token by `(source,destination,sourceToken)`
  - service binding by `(chainSelector,serviceKey)`
- Enumerable indexes:
  - chain selectors
  - lane keys
  - lane-token keys
  - service keys
- Pagination:
  - active-only slices for `getSupportedChains` and `getActiveLanes`

Events emitted for indexability:
- `ChainUpserted`, `ChainActivationUpdated`
- `LaneUpdated`, `LaneActivationUpdated`
- `LaneTokenUpdated`, `LaneTokenActivationUpdated`
- `ServiceBindingUpdated`, `ServiceActivationUpdated`

Important error paths:
- unknown chain/lane/token/service
- zero selector/address/chainId
- chainId-selector mismatch (`SelectorAlreadyMapped`, `ChainIdAlreadyMapped`)

---

## 4. Resolver Modes in Stateful Contracts
Integrated files:
- `contracts/src/MessageSender.sol` (contract: `MessagingSender`)
- `contracts/src/TokenTransferSender.sol`
- `contracts/src/ProgrammableTokenSender.sol`
- `contracts/src/AutomatedTrader.sol`

New public state:
- `chainRegistry()`
- `resolverMode()`

New config method:
- `configureChainRegistry(address registry, uint8 mode)`

Mode semantics:
- `DISABLED` (0): skip registry validation, rely on legacy allowlists
- `MONITOR` (1): emit `RegistryPolicyViolation`, continue
- `ENFORCE` (2): revert `RegistryPolicyBlocked(reason)`

Validation checklist performed in integrated send/order paths:
1. Resolve source selector from `block.chainid` via `getSelectorByChainId`
2. Source chain supported
3. Destination chain supported
4. Lane active
5. Token transferable on lane (token paths only)
6. Source service binding equals current contract address
7. Destination service binding equals receiver contract

Service keys used:
- `MESSAGE_SENDER`, `MESSAGE_RECEIVER`
- `TOKEN_TRANSFER_SENDER`, `TOKEN_TRANSFER_RECEIVER`
- `PROGRAMMABLE_TRANSFER_SENDER`, `PROGRAMMABLE_TRANSFER_RECEIVER`
- `AUTOMATED_TRADER` (source for auto-trader path)

Compatibility guarantee:
- Existing allowlist functions are still active.
- Behavior is unchanged when `resolverMode=DISABLED`.

---

## 5. Deployment and Admin Scripts

## 5.1 New script file
File: `contracts/script/Deploychainregistry.s.sol`

Script contracts:
- `DeployChainRegistry`
- `SeedDefaultChainsAndLanes`
- `SeedDefaultLaneTokens`
- `SeedServiceBindings`
- `ConfigureResolverOnSendersAndTrader`
- `CheckChainRegistryState`

Core env vars:
- `CHAIN_REGISTRY_CONTRACT`
- `CHAIN_RESOLVER_MODE` (`DISABLED|MONITOR|ENFORCE`)

Chain seeding env vars (`SeedDefaultChainsAndLanes`):
- `CHAIN_DEFAULT_FEE_TOKEN_MODE` (optional, default `3`)
- `CHAIN_SEPOLIA_ROUTER`, `CHAIN_SEPOLIA_LINK_TOKEN`, `CHAIN_SEPOLIA_WRAPPED_NATIVE`, `CHAIN_SEPOLIA_ACTIVE`
- `CHAIN_AMOY_ROUTER`, `CHAIN_AMOY_LINK_TOKEN`, `CHAIN_AMOY_WRAPPED_NATIVE`, `CHAIN_AMOY_ACTIVE`
- `CHAIN_ARBITRUM_SEPOLIA_ROUTER`, `CHAIN_ARBITRUM_SEPOLIA_LINK_TOKEN`, `CHAIN_ARBITRUM_SEPOLIA_WRAPPED_NATIVE`, `CHAIN_ARBITRUM_SEPOLIA_ACTIVE`
- `CHAIN_BASE_SEPOLIA_ROUTER`, `CHAIN_BASE_SEPOLIA_LINK_TOKEN`, `CHAIN_BASE_SEPOLIA_WRAPPED_NATIVE`, `CHAIN_BASE_SEPOLIA_ACTIVE`
- `CHAIN_OP_SEPOLIA_ROUTER`, `CHAIN_OP_SEPOLIA_LINK_TOKEN`, `CHAIN_OP_SEPOLIA_WRAPPED_NATIVE`, `CHAIN_OP_SEPOLIA_ACTIVE`

Lane token seeding env vars (`SeedDefaultLaneTokens`):
- `CHAIN_TOKEN_SOURCE_SELECTOR`
- `CHAIN_TOKEN_DESTINATION_SELECTOR`
- `CHAIN_TOKEN_SOURCE_ADDRESS`
- `CHAIN_TOKEN_DESTINATION_ADDRESS`
- `CHAIN_TOKEN_DECIMALS`
- `CHAIN_TOKEN_SYMBOL`
- `CHAIN_TOKEN_ACTIVE` (optional)

Service binding env vars (`SeedServiceBindings`):
- `CHAIN_SERVICE_SELECTOR`
- `CHAIN_SERVICE_KEY`
- `CHAIN_SERVICE_CONTRACT`
- `CHAIN_SERVICE_ACTIVE` (optional)

Resolver wiring env vars (`ConfigureResolverOnSendersAndTrader`):
- `MESSAGE_SENDER_CONTRACT`
- `TOKEN_SENDER_CONTRACT`
- `PROGRAMMABLE_SENDER_CONTRACT`
- `AUTOMATED_TRADER_CONTRACT`

## 5.2 Updated deployment scripts
Updated to support resolver wiring:
- `contracts/script/Deploysender.s.sol`
- `contracts/script/Deploytokentransfer.s.sol`
- `contracts/script/Deployprogrammable.s.sol`
- `contracts/script/Deployautomation.s.sol`

Each now reads:
- `CHAIN_REGISTRY_CONTRACT`
- `CHAIN_RESOLVER_MODE`

And calls `configureChainRegistry` when enabled.

---

## 6. CRE Runtime Integration

New files:
- `transaction-workflow/chain-resolver.types.ts`
- `transaction-workflow/chain-resolver.ts`

Integrated into:
- `transaction-workflow/chainshield.ts`
- `transaction-workflow/autopilot.ts`
- `transaction-workflow/autopilot.types.ts`

### 6.1 Request and output contract
Input (`ResolveRequest`):
- `walletChainId`
- `destinationChainId`
- `serviceType`
- `token`
- `amount`
- `action`
- `recipient`

Output:
- `ResolvedExecutionConfig`
- `PreflightReport`

State model:
- `READY`
- `BLOCKED`
- `DEGRADED`

Blocked reason taxonomy:
- `CHAIN_UNSUPPORTED`
- `LANE_DISABLED`
- `CONTRACT_NOT_DEPLOYED`
- `TOKEN_MAPPING_MISSING`
- `SECURITY_BLOCKED`
- `FEE_ESTIMATION_FAILED`
- `FINALITY_DELAYED`

### 6.2 Resolver flow (`resolveExecutionConfig`)
1. Load source chain selector from registry (`getSelectorByChainId`)
2. Load source/destination chain records (`getChainBySelector`)
3. Verify lane (`isLaneActive`)
4. Verify token mapping/transferability (`isTokenTransferable`)
5. Resolve service bindings (`getServiceContract`)
6. Build deterministic preflight + resolved config
7. Return state with deterministic reason code

### 6.3 Service mapping in resolver
`chain-resolver.ts` maps service types to source/destination service keys, e.g.:
- `CHAINSHIELD_TRANSFER` -> `TOKEN_TRANSFER_SENDER` / `TOKEN_TRANSFER_RECEIVER`
- `DCA` -> `AUTOMATED_TRADER` / `PROGRAMMABLE_TRANSFER_RECEIVER`
- `MESSAGE` -> `MESSAGE_SENDER` / `MESSAGE_RECEIVER`

### 6.4 Cache behavior
- In-memory cache keyed by request dimensions.
- TTL controlled by `chainResolver.cacheTtlMs`.

---

## 7. Config Migration (Staging/Production)
Updated config files:
- `transaction-workflow/config.chainshield.staging.json`
- `transaction-workflow/config.chainshield.production.json`
- `transaction-workflow/config.autopilot.staging.json`
- `transaction-workflow/config.autopilot.production.json`

New block:
```json
"chainResolver": {
  "enabled": true,
  "registryAddressByChainId": { "...": "0x..." },
  "chainSelectorByChainId": { "...": "..." },
  "mode": "onchain",
  "cacheTtlMs": 30000,
  "strict": true
}
```

Field meaning:
- `enabled`: turn resolver path on/off in workflow runtime config
- `registryAddressByChainId`: bootstrap registry address lookup
- `chainSelectorByChainId`: known selector map for supported chains
- `mode`: current resolver backend mode (`onchain`)
- `cacheTtlMs`: cache lifetime
- `strict`: fail fast when required resolver dependencies are missing

Current bootstrap reality:
- Some checked-in configs still use placeholder `0x000...000` registry addresses.
- Replace placeholders before live operation.

---

## 8. End-to-End Runtime Flow

## 8.1 ChainShield flow
1. Request enters `chainshield.ts`
2. `resolveExecutionConfigFromRegistry(...)` resolves route + contracts
3. Preflight generated (`source/destination/lane/token/contracts`)
4. Feature 6 check runs (existing behavior)
5. Feature 5 record phases are produced (existing behavior)
6. Execution:
   - allowed path submits source-chain action
   - blocked path returns deterministic blocked outcome

## 8.2 AutoPilot DCA flow
1. Request enters `autopilot.ts` (HTTP/Cron)
2. Shared resolver resolves chain/lane/token/contracts
3. AutoPilot enriches resolved output with DCA fields (`executionMode`, `receiverContract`, `automatedTrader`)
4. Feature 6 gate + Gemini decision flow execute
5. Feature 5 record phases remain unchanged
6. Execution branch respects policy flags and security mode

---

## 9. Validation and Test Coverage
Resolver-specific tests:
- `contracts/test/ChainRegistry.t.sol`
  - chain/lane/token/service CRUD and lookup
  - unauthorized write reverts
  - deterministic duplicate upserts
  - pagination behavior
- `contracts/test/ChainResolverIntegration.t.sol`
  - `DISABLED` mode keeps legacy flow working
  - `MONITOR` emits violation and continues
  - `ENFORCE` blocks service mismatch
  - `ENFORCE` blocks non-transferable token

Regression suites still validated:
- `MessagingTest`
- `TokenTransferTest`
- `ProgrammableTokenTest`
- `AutomatedTradingTest`

---

## 10. Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| Resolver configured but no blocking occurs | `resolverMode=DISABLED` | Set `CHAIN_RESOLVER_MODE=MONITOR` or `ENFORCE`, then call `configureChainRegistry` |
| Immediate registry violation on every call | source selector missing (`getSelectorByChainId=0`) | Upsert source chain record with correct `chainId` and selector |
| `DESTINATION_SERVICE_NOT_BOUND` | wrong/missing destination service binding | Seed `setServiceContract` for destination selector + service key |
| `LANE_DISABLED` | lane not seeded or inactive | Seed lane with `setLane` and ensure `isActive=true` |
| `TOKEN_NOT_TRANSFERABLE` / mapping missing | lane-token mapping absent/inactive | Seed `setLaneToken` and activate lane token |
| Tx succeeds in monitor although violation exists | expected monitor behavior | Use `ENFORCE` for fail-closed behavior |
| ENFORCE revert difficult to parse | revert carries hashed reason | Decode revert selector + bytes32 reason, compare to known constants in sender/trader files |
| CRE resolver returns blocked due to contracts | service key mapping mismatch in registry | Verify resolver service key and registry binding pair |

---

## 11. Rollout Guidance
Recommended rollout sequence:
1. Deploy `ChainRegistry`.
2. Seed chains and lanes.
3. Seed lane-token mappings.
4. Seed service bindings.
5. Configure contracts with `resolverMode=MONITOR`.
6. Observe `RegistryPolicyViolation` events and fix missing bindings/mappings.
7. Move contracts to `resolverMode=ENFORCE`.
8. Keep legacy allowlists as fallback during stabilization.
9. After stable operation, deprecate operational reliance on legacy allowlist management.

---

## Public API / Interface Changes

### Solidity
New:
- `contracts/src/ChainRegistry.sol`
- `contracts/src/interfaces/IChainRegistry.sol`

Added across four stateful contracts:
- `configureChainRegistry(address,uint8)`
- `chainRegistry()`
- `resolverMode()`
- events:
  - `ChainRegistryConfigured`
  - `RegistryPolicyViolation`
- error:
  - `RegistryPolicyBlocked`

### TypeScript
New module/types:
- `transaction-workflow/chain-resolver.ts`
- `transaction-workflow/chain-resolver.types.ts`

Exported resolver functions:
- `resolveExecutionConfig(...)`
- `loadChainMeta(...)`
- `resolveServiceContracts(...)`

Runtime config extension:
- `chainResolver` block in ChainShield and AutoPilot configs.

---

## Assumptions and Defaults
1. Single-file documentation only for this step.
2. Registry is the authoritative runtime source of truth.
3. Dual-mode migration is retained to avoid breaking existing flows.
4. Feature 5 and Feature 6 behavior is unchanged and remains mandatory in runtime flow.
5. Checked-in placeholder registry addresses are intentional bootstrap values and must be replaced for live execution.
