# chainAlert Wallet Integration Spec (MetaMask Extension, Wallet API)

This document defines how the frontend repo should connect to the MetaMask **web extension** for chainAlert.

## 1) Scope

- Wallet role: user authentication + rule management.
- Wallet does **not** run monitoring jobs.
- CRE workflow remains the autonomous monitor/evaluator.
- Integration target: desktop web dapp + MetaMask extension via Wallet API.

## 2) Official Integration Basis (MetaMask)

Use MetaMask Wallet API for extension-based web dapps.

- Use **EIP-6963** provider discovery (recommended) instead of relying only on `window.ethereum`.
- Use `provider.request(...)` JSON-RPC calls for account/network/transaction actions.
- Use provider events for account/network/session state.

If you later need stronger mobile consistency or deeplinking, migrate to MetaMask SDK.

## 3) Contract Surface (Canonical ABI)

Primary contract: `ChainAlertRegistry`.

### Read

- `getUserRuleIds(address owner) -> uint256[]`
- `getRule(uint256 ruleId) -> AlertRule`
- `getRuleState(uint256 ruleId) -> AlertState`

### Write (wallet signed)

- `upsertRule(uint256 ruleId, uint8 alertType, bool enabled, uint32 cooldownSeconds, uint32 rearmSeconds, string paramsJson) -> uint256`
  - Use `ruleId = 0` to create.
  - Use existing `ruleId` to update.
- `setRuleEnabled(uint256 ruleId, bool enabled)`

### Write (workflow only)

- `recordEvaluation(...)`
- `recordTrigger(...)`
- `recordResolve(...)`

## 4) MetaMask Connection Flow (Required)

### 4.1 Discover provider (EIP-6963)

- Listen for `eip6963:announceProvider`.
- Trigger discovery with `window.dispatchEvent(new Event("eip6963:requestProvider"))`.
- Present detected wallets to the user; user picks MetaMask.

### 4.2 Connect account (user action only)

- Connect button must call `eth_requestAccounts`.
- Handle `4001` as user-rejected request.
- While request is pending, disable duplicate connect actions.

### 4.3 Sync account state

- On startup, call `eth_accounts`.
- Subscribe to `accountsChanged` and update session state accordingly.

### 4.4 Sync network state

- On startup, call `eth_chainId`.
- Subscribe to `chainChanged`.
- MetaMask recommends reloading on chain change unless you have explicit in-app state migration logic.

## 5) Network Switching + Adding

Use these together:

1. `wallet_switchEthereumChain`
2. If code `4902`, call `wallet_addEthereumChain`

This is required for reliable onboarding to supported chains.

## 6) Session/Disconnect Semantics

- Connection state in provider (`isConnected`) is RPC connectivity, not account permission.
- Dapp account access is permission-based (`eth_requestAccounts` / `eth_accounts`).
- For explicit wallet-disconnect UX, use:
  - `wallet_revokePermissions` (revoke `eth_accounts` permission)
  - `wallet_getPermissions` (detect permission state)

## 7) Wallet Event Handling (must implement)

Register and cleanup listeners:

- `accountsChanged`
- `chainChanged`
- `connect`
- `disconnect`

Always remove listeners on component unmount/cleanup.

## 8) Minimal TypeScript Connector (frontend repo)

```ts
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on(event: string, handler: (...args: unknown[]) => void): void
  removeListener(event: string, handler: (...args: unknown[]) => void): void
  isConnected?: () => boolean
  isMetaMask?: boolean
}

export type Eip6963ProviderDetail = {
  info: { rdns: string; uuid: string; name: string; icon: string }
  provider: Eip1193Provider
}

export async function connect(provider: Eip1193Provider): Promise<string | undefined> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[]
  return accounts?.[0]
}

export async function ensureChain(
  provider: Eip1193Provider,
  params: { chainIdHex: string; chainName: string; rpcUrl: string; nativeCurrency?: { name: string; symbol: string; decimals: number }; blockExplorerUrl?: string }
): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainIdHex }] })
  } catch (err: any) {
    if (err?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: params.chainIdHex,
          chainName: params.chainName,
          rpcUrls: [params.rpcUrl],
          nativeCurrency: params.nativeCurrency,
          blockExplorerUrls: params.blockExplorerUrl ? [params.blockExplorerUrl] : undefined
        }]
      })
      return
    }
    throw err
  }
}
```

## 9) Chain Map (current project)

- `11155111` Ethereum Sepolia (`0xaa36a7`)
- `80002` Polygon Amoy (`0x13882`)
- `421614` Arbitrum Sepolia (`0x66eee`)
- `84532` Base Sepolia (`0x14a34`)
- `11155420` OP Sepolia (`0xaa37dc`)

Runtime selectors/config live in:

- `transaction-workflow/config.chainAlert.intelligence.staging.json`
- `transaction-workflow/config.chainAlert.intelligence.production.json`

## 10) Deployed Addresses Manifest

Staging:

- `ChainAlertRegistry`: set in `alertRegistryByChainId` (placeholder until deployment)
- `AutomatedTrader`: set in `automatedTraderByChainId`
- `TokenVerifier`: set in `tokenVerifierByChainId`

Production:

- same keys/shape as staging.

## 11) Error Codes / UX Mapping

Contract-level reverts to display in wallet UI:

- `RuleNotFound(ruleId)`
- `UnauthorizedRuleOwner(caller, ruleId)`
- `EmptyParams()`
- `UnauthorizedWorkflow(caller)` (unexpected for wallet rule writes)

Wallet/RPC behavior:

- `4001`: user rejected account/tx request.
- `4902`: chain not added; call `wallet_addEthereumChain` then retry switch.

## 12) Security Controls (required)

Implement wallet-facing dapp security baseline:

- HTTPS only
- CSP policy at minimum:
  - `default-src 'self'; frame-ancestors 'none'`

## 13) Frontend Repo Checklist

- EIP-6963 provider discovery UI for wallet selection.
- Connect flow (`eth_requestAccounts`) from explicit user action.
- Account sync (`eth_accounts` + `accountsChanged`).
- Network sync (`eth_chainId` + `chainChanged`).
- Add/switch chain flow (`wallet_switchEthereumChain` + fallback `wallet_addEthereumChain`).
- Rule write transactions (`upsertRule`, `setRuleEnabled`).
- Read-after-write refresh (`getUserRuleIds`, `getRule`, `getRuleState`).
- Listener cleanup on route/component unmount.
