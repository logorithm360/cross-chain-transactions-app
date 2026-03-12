# ChainPilot — AI-Powered Cross-Chain DeFi Suite

> **Built on Chainlink CCIP · Chainlink Automation · Chainlink Runtime Environment (CRE)**

ChainPilot is a unified, AI-powered DeFi infrastructure that makes on-chain participation safe, automated, and accessible to everyone — from DeFi veterans to first-time users. It bundles four production-grade services into a single orchestrated system, all accessible through one CLI entry point and a MetaMask web-signer.

---

## What ChainPilot Does

| Service | What it solves | Who it is for |
|---|---|---|
| **ChainShield** | Secure cross-chain token transfers with AI safety verification | Anyone sending tokens across chains |
| **AutoPilot DCA** | AI-gated recurring investments — set once, AI manages execution | Investors who want automated, intelligent DCA |
| **CrossVault** | AI-recommended cross-chain yield routing with optional auto-execution | Users wanting to earn yield without manual bridging |
| **ChainAlert** | Real-time wallet and portfolio monitoring with AI-powered alerts | Anyone who needs to stay informed without watching charts |

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [How a User Gets Access to Everything](#2-how-a-user-gets-access-to-everything)
3. [How the Four Services Connect](#3-how-the-four-services-connect)
4. [Service Deep-Dive](#4-service-deep-dive)
5. [Project Structure](#5-project-structure)
6. [Prerequisites](#6-prerequisites)
7. [Installation & Setup](#7-installation--setup)
8. [Running Locally](#8-running-locally)
9. [Simulating Workflows](#9-simulating-workflows)
10. [Live Transaction Path (MetaMask)](#10-live-transaction-path-metamask)
11. [Contract Management](#11-contract-management)
12. [Testing & Verification](#12-testing--verification)
13. [Troubleshooting](#13-troubleshooting)
14. [Appendix & Glossary](#14-appendix--glossary)

---

## 1. System Architecture

### The Big Picture

ChainPilot has three layers that work together. The user only ever interacts with Layer 1 — everything below is handled automatically.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  LAYER 1 — USER INTERFACE                                                   ║
║                                                                              ║
║   ┌─────────────────────────────┐      ┌──────────────────────────────┐     ║
║   │   CLI Orchestrator          │      │   Web-Signer (MetaMask UI)   │     ║
║   │                             │◄────►│                              │     ║
║   │  • Service menus            │      │  • Signs transaction intents │     ║
║   │  • Intent builder           │      │  • Public mode (tx hash)     │     ║
║   │  • Bridge server (SSE)      │      │  • Confidential mode         │     ║
║   │  • Status & logs            │      │    (no public tx hash)       │     ║
║   └─────────────────────────────┘      └──────────────────────────────┘     ║
║              │                                       │                       ║
║              └──────────────┬────────────────────────┘                       ║
║                             │  Bridge Session (sessionId + token)            ║
╚═════════════════════════════╪════════════════════════════════════════════════╝
                              │
╔═════════════════════════════╪════════════════════════════════════════════════╗
║  LAYER 2 — CRE WORKFLOW ENGINE          │                                   ║
║                             ▼                                                ║
║   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ║
║   │ chainshield  │  │  autopilot   │  │  crossvault  │  │ chainAlert    │  ║
║   │    .ts       │  │    .ts       │  │    .ts       │  │ .intelligence │  ║
║   │              │  │              │  │              │  │    .ts        │  ║
║   │ HTTP trigger │  │ Cron trigger │  │ Cron trigger │  │ Cron trigger  │  ║
║   │              │  │ HTTP trigger │  │ HTTP trigger │  │ HTTP trigger  │  ║
║   │ AI: safety   │  │ AI: market   │  │ AI: yield    │  │ AI: context   │  ║
║   │   check      │  │   analysis   │  │   routing    │  │   & alerts    │  ║
║   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  ║
║          │                 │                  │                   │          ║
║          └─────────────────┴──────────────────┴───────────────────┘          ║
║                                       │                                      ║
║                              Chainlink DON (consensus)                       ║
╚═══════════════════════════════════════╪══════════════════════════════════════╝
                                        │
╔═══════════════════════════════════════╪══════════════════════════════════════╗
║  LAYER 3 — ON-CHAIN INFRASTRUCTURE    │                                     ║
║                                       ▼                                      ║
║   SOURCE CHAIN (Ethereum Sepolia)              DESTINATION CHAINS            ║
║                                                                              ║
║   ┌─────────────────────────────┐     CCIP     ┌────────────────────────┐   ║
║   │  TokenTransferSender        │─────────────►│  TokenTransferReceiver │   ║
║   │  ProgrammableTokenSender    │─────────────►│  ProgrammableReceiver  │   ║
║   │  AutomatedTrader            │              │  (Amoy / Arb / Base /  │   ║
║   │  ChainAlertRegistry         │              │   Fuji)                │   ║
║   │  SecurityManager            │              └────────────────────────┘   ║
║   │  TokenVerifier              │                                            ║
║   │  ChainRegistry              │              ┌────────────────────────┐   ║
║   └─────────────────────────────┘              │  Chainlink Automation  │   ║
║                                                │  (upkeep for DCA)      │   ║
║                                                └────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

### Main Control Loop

This is the exact sequence of events every time a user submits an action through ChainPilot:

```
┌──────────┐                                                          
│   USER   │                                                          
└────┬─────┘                                                          
     │  1. Selects service in CLI (DCA / Transfer / Vault / Alert)    
     ▼                                                                
┌─────────────────┐                                                   
│  CLI            │  2. Builds a typed intent object                  
│  Orchestrator   │     { serviceType, user, token, amount, ... }     
└────┬────────────┘                                                   
     │  3. Opens a bridge session (sessionId + one-time token)        
     ▼                                                                
┌─────────────────┐                                                   
│  Bridge Server  │  4. Generates a signer URL and prints it to CLI   
│  (SSE / HTTP)   │     http://127.0.0.1:5173?session=<id>&t=<token>  
└────┬────────────┘                                                   
     │  5. User opens URL in browser → MetaMask connects              
     ▼                                                                
┌─────────────────┐                                                   
│  Web-Signer     │  6. User reviews intent details and approves      
│  (MetaMask UI)  │     PUBLIC  → MetaMask signs, tx hash visible     
└────┬────────────┘     PRIVATE → confidential submission, no hash    
     │  7. Signed intent sent back to bridge                          
     ▼                                                                
┌─────────────────┐                                                   
│  CRE Workflow   │  8. Workflow receives trigger (HTTP or Cron)      
│  (DON nodes)    │     AI layer evaluates conditions                 
└────┬────────────┘     Consensus reached across DON nodes            
     │  9. Write to chain if conditions pass                          
     ▼                                                                
┌─────────────────┐                                                   
│  CCIP / On-     │  10. CCIP delivers tokens/message cross-chain     
│  Chain Contract │      Automation executes upkeep (DCA)             
└────┬────────────┘      Contract state updated                       
     │  11. Bridge pushes status events back via SSE                  
     ▼                                                                
┌──────────┐                                                          
│   USER   │  12. CLI shows confirmation, tx hash, CCIP Explorer link 
└──────────┘                                                          
```

---

## 2. How a User Gets Access to Everything

ChainPilot is designed so that a user never needs to understand the underlying infrastructure. One command starts everything. One menu routes to all four services.

### Starting ChainPilot

```bash
# Terminal 1 — Web-Signer (MetaMask UI)
cd transaction-workflow
bun run web-signer:dev
# → http://127.0.0.1:5173

# Terminal 2 — CLI Orchestrator
cd transaction-workflow
ORCHESTRATOR_BRIDGE_PORT=8787 bun run cli:start
```

### What the User Sees

```
  ╔═══════════════════════════════════════════════════╗
  ║         ChainPilot — Chainlink DeFi Terminal      ║
  ║   ChainShield · AutoPilot · CrossVault · Alerts   ║
  ╚═══════════════════════════════════════════════════╝

  Connected: 0x1234...abcd  │  Ethereum Sepolia  │  0.45 ETH

  What would you like to do?

  [1]  ChainShield Transfer  —  Send tokens cross-chain safely
  [2]  AutoPilot DCA         —  Set up AI-managed recurring investment
  [3]  CrossVault            —  Route tokens to cross-chain yield
  [4]  ChainAlert            —  Monitor wallet and set alert rules
  [5]  View all active services
  [Q]  Quit
```

Each option leads to a guided sub-menu that collects all required inputs step by step, shows a confirmation summary, and then generates the signer URL for MetaMask approval. The user never writes a transaction manually.

### The Two Signing Modes

```
PUBLIC MODE                          CONFIDENTIAL MODE
─────────────────────────────────    ─────────────────────────────────
For: standard transfers, DCA,        For: private ChainShield transfers,
     alert rules, vault deposits          CrossVault private routing

Flow: MetaMask signs tx               Flow: confidential submission path
      tx hash visible on-chain              no public tx hash generated
      verifiable on Etherscan               execution confirmed via SSE

Use when: you want full               Use when: privacy is required or
transparency and traceability         you do not need a public trace
```

---

## 3. How the Four Services Connect

All four services share the same underlying infrastructure. They are not independent apps — they are coordinated layers of the same system, sharing contracts, secrets, and the same bridge session pattern.

```
                    ┌─────────────────────────────────────────────────────┐
                    │              SHARED INFRASTRUCTURE                  │
                    │                                                     │
                    │  ChainRegistry ── resolves chain selectors & RPCs  │
                    │  TokenVerifier ── AI token safety scoring           │
                    │  SecurityManager ── rate limits, access control     │
                    │  CCIP Router ── cross-chain message transport       │
                    └──────────────────┬──────────────────────────────────┘
                                       │  all four services use these
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
               ▼                       ▼                       ▼                       ▼
  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
  │   CHAINSHIELD      │  │   AUTOPILOT DCA    │  │   CROSSVAULT       │  │   CHAINALERT       │
  │                    │  │                    │  │                    │  │                    │
  │ • Token verify     │  │ • Order creation   │  │ • AI vault pick    │  │ • Rule registry    │
  │ • CCIP send        │  │ • AI market gate   │  │ • PLAN vs EXECUTE  │  │ • State machine    │
  │ • Public/private   │  │ • Automation       │  │ • Prog. sender     │  │ • OpenAI context   │
  │   path             │  │   upkeep           │  │ • Cross-chain      │  │ • Alert delivery   │
  │                    │  │ • CCIP delivery    │  │   deposit          │  │                    │
  │ Contract:          │  │ Contract:          │  │ Contract:          │  │ Contract:          │
  │ TokenTransfer      │  │ AutomatedTrader    │  │ Programmable       │  │ ChainAlert         │
  │ Sender/Receiver    │  │ (+ Automation)     │  │ Sender/Receiver    │  │ Registry           │
  └────────────────────┘  └────────────────────┘  └────────────────────┘  └────────────────────┘
```

### How ChainAlert Connects to the Other Three

ChainAlert does not just monitor external price feeds — it actively watches the output of the other three services. This makes it the system's nervous system:

```
  AutoPilot DCA ──► DCA_ORDER_FAILED alert     ─┐
  AutoPilot DCA ──► DCA_LOW_FUNDS alert         │
  ChainShield   ──► CCIP_TRANSFER_STUCK alert   ├──► ChainAlert evaluates
  CrossVault    ──► VAULT_POSITION_AT_RISK alert │    → AI explains why
  All services  ──► TOKEN_FLAGGED alert         ─┘    → User notified
```

---

## 4. Service Deep-Dive

### ChainShield — Secure Cross-Chain Transfer

**What it does:** Transfers tokens from Ethereum Sepolia to any supported destination chain. Before every transfer, the AI layer runs a safety check on the token and recipient. Users can choose a public transfer (visible on Etherscan) or a confidential transfer (private path, no public hash).

```
User submits transfer intent
        │
        ▼
┌───────────────────────┐
│  TokenVerifier.sol    │  AI scores the token: SAFE / SUSPICIOUS / MALICIOUS
│  + AI safety check    │  MALICIOUS → transfer blocked immediately
└──────────┬────────────┘  SUSPICIOUS → user warned, can still proceed
           │  SAFE
           ▼
┌───────────────────────┐
│  TokenTransferSender  │  Builds CCIP message with token + action
│  .sol (Sepolia)       │  Approves LINK for fees, calls ccipSend()
└──────────┬────────────┘
           │  CCIP cross-chain delivery
           ▼
┌───────────────────────┐
│  TokenTransferReceiver│  Receives tokens on destination chain
│  .sol (Amoy/Arb/etc)  │  Executes action: transfer / stake / swap / deposit
└───────────────────────┘
```

**Config:** `transaction-workflow/config.chainshield.*.json`

---

### AutoPilot DCA — AI-Gated Recurring Investment

**What it does:** Users configure a recurring investment order once. On every execution cycle, the AI evaluates current market conditions before submitting the transaction. If conditions are unfavourable, the AI pauses or skips — protecting the user from poorly-timed executions. Chainlink Automation triggers upkeep on schedule.

```
Chainlink Automation fires checkUpkeep()
        │
        ▼
┌───────────────────────┐
│  AutomatedTrader.sol  │  Is order ready? Is it funded? Is interval elapsed?
│  performUpkeep()      │  → YES: proceed  → NO: skip silently
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│  CRE Workflow         │  AI (OpenAI) evaluates:
│  autopilot.ts         │  market volatility, sentiment, price trend
│  AI gate              │  → EXECUTE / PAUSE / SKIP decision
└──────────┬────────────┘
           │  EXECUTE
           ▼
┌───────────────────────┐
│  CCIP Send            │  Tokens sent cross-chain
│  + message ID stored  │  Message ID stored in contract circular buffer
└──────────┬────────────┘  (lastPendingMessageIds, lastCompletedMessageIds)
           │
           ▼
┌───────────────────────┐
│  AutomatedTrader      │  confirmExecution() called by workflow
│  Receiver (dest chain)│  Order status updated: PENDING → COMPLETED
└───────────────────────┘
```

**DCA Order Status Flow:**
```
PENDING → SCHEDULED → EXECUTING → PENDING_CCIP → COMPLETED
                  ↓                      ↓
              PAUSED_BY_AI          FAILED (stored in lastFailedMessageIds)
                  ↓
              INSUFFICIENT_FUNDS
```

**Config:** `transaction-workflow/config.autopilot.*.json`

---

### CrossVault — AI-Recommended Cross-Chain Yield

**What it does:** The AI analyses available yield opportunities across supported chains and recommends the best vault for the user's risk profile and token. The user can request a PLAN (AI recommendation only, no transaction) or EXECUTE (AI recommends and the workflow acts). Tokens are bridged via CCIP and deposited automatically.

```
User submits vault intent
{ intent: "REBALANCE", riskProfile: "MEDIUM", executionMode: "PLAN" }
        │
        ▼
┌───────────────────────┐
│  CRE Workflow         │  AI scans available vaults across chains
│  crossvault.ts        │  Scores by: APY, risk, liquidity, protocol safety
│  AI recommendation    │  Returns ranked list + recommended action
└──────────┬────────────┘
           │
     ┌─────┴──────┐
     │            │
  PLAN mode    EXECUTE mode
     │            │
     ▼            ▼
  Returns      ┌──────────────────────┐
  plan to      │ ProgrammableToken    │  CCIP send with execution data encoded
  user (no     │ Sender.sol           │  in the CCIP message
  write)       └──────────┬───────────┘
                          │  CCIP delivery
                          ▼
                ┌──────────────────────┐
                │ ProgrammableToken    │  Decodes message, calls vault.deposit()
                │ Receiver.sol         │  on destination chain automatically
                └──────────────────────┘
```

**Config:** `transaction-workflow/config.crossvault.*.json`

---

### ChainAlert Intelligence — AI-Powered Monitoring

**What it does:** Runs continuously on a cron schedule, evaluating user-defined alert rules against live on-chain data. When a rule triggers, the AI generates a plain-language explanation of what happened and what the user should consider doing. The state machine prevents alert spam by enforcing cooldown periods between re-fires.

```
Every 15 minutes (cron) or on-demand (HTTP):
        │
        ▼
┌───────────────────────┐
│  ChainAlertRegistry   │  Read all active user rules from on-chain registry
│  .sol                 │  e.g. PORTFOLIO_DROP_15%, DCA_ORDER_FAILED, etc.
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│  Data collectors      │  Fetch current state for each rule:
│  (CRE workflow)       │  - portfolio value via price feeds
│                       │  - token flags via TokenVerifier
│                       │  - DCA order status via AutomatedTrader
│                       │  - CCIP message status
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│  Rule Evaluator       │  Compare current state against stored baseline
│  + State Machine      │  WATCHING → TRIGGERED → COOLING_DOWN → WATCHING
└──────────┬────────────┘  (deduplication prevents alert spam)
           │  rule triggered
           ▼
┌───────────────────────┐
│  AI Context Layer     │  OpenAI generates:
│  (OpenAI)             │  - Severity: INFO / WARNING / CRITICAL
│                       │  - Plain-language explanation of why it fired
│                       │  - Recommended actions for the user
│                       │  - isLikelyNoise flag (suppresses false positives)
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│  Alert Delivery       │  Notification sent to user (webhook / CLI)
│  + on-chain record    │  Alert history written to ChainAlertRegistry
└───────────────────────┘
```

**Supported rule types:**

| Rule | Trigger condition |
|---|---|
| `PORTFOLIO_DROP_PERCENT` | Portfolio drops X% from baseline |
| `TOKEN_FLAGGED_SUSPICIOUS` | Any held token receives a suspicious/malicious flag |
| `DCA_ORDER_FAILED` | A DCA execution fails on any chain |
| `DCA_EXECUTION_STUCK` | A CCIP message unconfirmed after N hours |
| `DCA_LOW_FUNDS` | LINK balance covers fewer than N executions |
| `WALLET_LARGE_OUTFLOW` | Outflow exceeds $X in a rolling window |
| `TOKEN_PRICE_SPIKE` | Any held token moves ±X% in Y minutes |
| `WALLET_NEW_TOKEN_RECEIVED` | Unknown token appears in wallet (dust attack detection) |

**Config:** `transaction-workflow/config.chainAlert.intelligence.*.json`

---

## 5. Project Structure

```
chainpilot/
│
├── transaction-workflow/          # All CRE workflows + CLI + web-signer
│   │
│   ├── cli/                       # CLI orchestrator
│   │   ├── index.ts               # Entry point — main menu loop
│   │   ├── screens/               # One file per service (dca, transfer, vault, alerts)
│   │   ├── contracts/             # On-chain read/write via viem
│   │   ├── wallet/                # Wallet connection (private key / WalletConnect)
│   │   └── utils/                 # Display formatting, input validation
│   │
│   ├── web-signer/                # MetaMask signing UI (Vite + React)
│   │   └── src/                   # Intent display, session handling, sign/submit
│   │
│   ├── chainshield.ts             # ChainShield CRE workflow
│   ├── autopilot.ts               # AutoPilot DCA CRE workflow
│   ├── crossvault.ts              # CrossVault CRE workflow
│   ├── chainAlert.intelligence.ts # ChainAlert CRE workflow
│   │
│   ├── config.chainshield.*.json  # Per-service CRE config (staging / production)
│   ├── config.autopilot.*.json
│   ├── config.crossvault.*.json
│   ├── config.chainAlert.intelligence.*.json
│   │
│   ├── secrets.autopilot.yaml           # Secret declarations for AutoPilot
│   ├── secrets.chainAlert.intelligence.yaml  # Secret declarations for ChainAlert
│   ├── secrets.yaml                     # Root secrets (OpenAI key)
│   │
│   ├── workflow.yaml              # CRE workflow targets (staging / production)
│   └── project.yaml              # CRE project config (RPCs, chain selectors)
│
├── contracts/
│   ├── src/
│   │   ├── AutomatedTrader.sol         # DCA order management + Automation
│   │   ├── TokenTransferSender.sol     # ChainShield source chain
│   │   ├── TokenTransferReceiver.sol   # ChainShield destination chain
│   │   ├── ProgrammableTokenSender.sol # CrossVault source chain
│   │   ├── ProgrammableTokenReceiver.sol # CrossVault destination chain
│   │   ├── ChainAlertRegistry.sol      # Alert rule storage + history
│   │   ├── TokenVerifier.sol           # AI token safety verification
│   │   ├── SecurityManager.sol         # Rate limiting, access control
│   │   └── ChainRegistry.sol           # Chain config registry
│   └── DEPLOYED_ADDRESSES.md          # ← source of truth for all addresses
│
├── .env                           # Environment variables (never commit)
└── package.json
```

---

## 6. Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0 | Runtime for CLI and workflows |
| [Node.js](https://nodejs.org) | ≥ 18 | Web-signer build tooling |
| [MetaMask](https://metamask.io) | Latest | Transaction signing |
| [CRE CLI](https://docs.chain.link/cre) | Latest | Workflow simulation and deployment |
| [Foundry / cast](https://getfoundry.sh) | Latest | Direct contract calls (optional) |

---

## 7. Installation & Setup

### Step 1 — Clone and install dependencies

```bash
git clone <repo-url>
cd cross-chain-transactions

# Install root dependencies
bun install

# Install workflow dependencies
cd transaction-workflow && bun install && cd ..
```

### Step 2 — Configure environment variables

Create a `.env` file in the repo root and fill in all required values:

```bash
# ── API Keys ──────────────────────────────────────────────────
INFURA_API_KEY=your_infura_key
OPENAI_API_KEY_ALL=your_openai_key
ETHERSCAN_API_KEY=your_etherscan_key

# ── Wallet ────────────────────────────────────────────────────
CRE_ETH_PRIVATE_KEY=0x...          # testnet key only — never use a funded mainnet key

# ── RPC URLs ──────────────────────────────────────────────────
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/<your-key>
AMOY_RPC_URL=https://polygon-amoy.infura.io/v3/<your-key>
ARBITRUM_SEPOLIA_RPC_URL=https://arbitrum-sepolia.infura.io/v3/<your-key>
BASE_SEPOLIA_RPC_URL=https://base-sepolia.infura.io/v3/<your-key>
FUJI_RPC_URL=https://avalanche-fuji.infura.io/v3/<your-key>

# ── Bridge ────────────────────────────────────────────────────
ORCHESTRATOR_BRIDGE_PORT=8787
```

### Step 3 — Verify deployed contract addresses

Open `contracts/DEPLOYED_ADDRESSES.md` and confirm all addresses match your deployment. This file is the single source of truth — every config file and workflow reads from it.

### Step 4 — Set workflow secrets (for deployed workflows)

```bash
# AutoPilot DCA secrets
cre secrets create transaction-workflow/secrets.autopilot.yaml --target autopilot-staging-settings

# ChainAlert secrets
cre secrets create transaction-workflow/secrets.chainAlert.intelligence.yaml --target chainAlert-intelligence-staging-settings
```

---

## 8. Running Locally

You need two terminal windows. Start the web-signer first, then the CLI.

**Terminal 1 — Web-Signer**
```bash
cd transaction-workflow
bun run web-signer:dev
# Listening at http://127.0.0.1:5173
```

**Terminal 2 — CLI Orchestrator**
```bash
cd transaction-workflow
ORCHESTRATOR_BRIDGE_PORT=8787 bun run cli:start
```

The CLI will display the main menu. Select any service and follow the prompts. When you reach the signing step, a URL will be printed in the CLI — open it in your browser to complete the MetaMask approval.

---

## 9. Simulating Workflows

Simulation lets you test workflow logic locally without deploying to the DON or sending real transactions. All four services support both cron simulation (trigger index 0) and HTTP trigger simulation (trigger index 1).

### ChainShield — HTTP trigger

```bash
cre workflow simulate transaction-workflow \
  -T chainshield-staging-settings \
  --trigger-index 0 \
  --http-payload '{
    "walletChainId": 11155111,
    "destinationChainId": 80002,
    "serviceType": "CHAINSHIELD_TRANSFER",
    "user": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "recipient": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "token": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
    "amount": "100000000000000000",
    "action": "transfer"
  }' \
  -e .env -v
```

### AutoPilot DCA — Cron trigger (evaluates all active orders)

```bash
cre workflow simulate transaction-workflow \
  -T autopilot-staging-settings \
  --trigger-index 0 \
  -e .env -v
```

### AutoPilot DCA — HTTP trigger (submit specific order)

```bash
cre workflow simulate transaction-workflow \
  -T autopilot-staging-settings \
  --trigger-index 1 \
  --http-payload '{
    "walletChainId": 11155111,
    "destinationChainId": 80002,
    "serviceType": "DCA",
    "executionMode": "RUN_UPKEEP",
    "user": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "token": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
    "amount": "100000000000000000",
    "recipient": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "receiverContract": "0x7541cEB8A6db4E8C8a58092e186f9d8ABEDC7Ef2",
    "action": "transfer",
    "cadenceSeconds": 3600,
    "recurring": true,
    "maxExecutions": 2,
    "deadline": 0
  }' \
  -e .env -v
```

> **Note:** `execution.submitted=false` in simulation output is expected and correct. Upkeep submission is disabled in simulation to prevent accidental on-chain writes.

### CrossVault — PLAN mode (no on-chain write)

```bash
cre workflow simulate transaction-workflow \
  -T crossvault-staging-settings \
  --trigger-index 1 \
  --http-payload '{
    "walletChainId": 11155111,
    "destinationChainId": 80002,
    "serviceType": "CROSSVAULT",
    "user": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "recipient": "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    "token": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
    "amount": "100000000000000000",
    "action": "transfer",
    "intent": "REBALANCE",
    "executionMode": "PLAN",
    "riskProfile": "MEDIUM",
    "approvalRequired": true,
    "approved": false
  }' \
  -e .env -v
```

### ChainAlert — Cron evaluation cycle

```bash
cre workflow simulate transaction-workflow \
  -T chainAlert-intelligence-staging-settings \
  --trigger-index 0 \
  -e .env -v
```

### ChainAlert — On-demand evaluation

```bash
cre workflow simulate transaction-workflow \
  -T chainAlert-intelligence-staging-settings \
  --trigger-index 1 \
  --http-payload '{"action": "RUN_EVALUATION_ONCE", "payload": {"chainId": 11155111}}' \
  -e .env -v
```

---

## 10. Live Transaction Path (MetaMask)

```
Step 1 ── Start both servers (see Section 8)

Step 2 ── Open the CLI and choose a service
          e.g. [2] AutoPilot DCA → Create new order → fill in prompts

Step 3 ── CLI prints a signer URL:
          ┌──────────────────────────────────────────────────────────┐
          │  Open in browser to sign:                                │
          │  http://127.0.0.1:5173?session=abc123&t=xyz789           │
          └──────────────────────────────────────────────────────────┘

Step 4 ── Open the URL in your browser
          Connect MetaMask → review the intent details
          Choose: PUBLIC (standard tx) or CONFIDENTIAL (private path)
          Click Approve

Step 5 ── MetaMask prompts for signature → confirm

Step 6 ── CLI receives confirmation via SSE bridge
          For public mode: tx hash shown → paste into Etherscan
          For CCIP transfers: CCIP message ID shown → paste into
          https://ccip.chain.link/msg/<messageId>
```

---

## 11. Contract Management

### Pause and resume a DCA order

```bash
# Pause order ID 0
cast send 0xCB8D1Cb78085ca8bce16aa3cFa2f68D7d099270F \
  "pauseOrder(uint256,bool)" 0 true \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $CRE_ETH_PRIVATE_KEY

# Resume order ID 0
cast send 0xCB8D1Cb78085ca8bce16aa3cFa2f68D7d099270F \
  "pauseOrder(uint256,bool)" 0 false \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $CRE_ETH_PRIVATE_KEY
```

### Read order snapshot

```bash
cast call 0xCB8D1Cb78085ca8bce16aa3cFa2f68D7d099270F \
  "getOrderSnapshot(uint256)((uint256,address,uint8,uint8,bool,bool,uint256,uint256,address,uint256,uint64,address,string,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,bytes32[3],bytes32[3],bytes32[3]))" \
  0 \
  --rpc-url $SEPOLIA_RPC_URL
```

### Check LINK and token balances

```bash
# LINK balance of contract
cast call <contract-address> "getLinkBalance()" --rpc-url $SEPOLIA_RPC_URL

# Token balance of contract
cast call <contract-address> "getTokenBalance(address)" <token-address> --rpc-url $SEPOLIA_RPC_URL
```

---

## 12. Testing & Verification

```bash
# TypeScript typecheck — CLI
cd transaction-workflow && bun run cli:typecheck

# Build web-signer (checks for compile errors)
cd transaction-workflow && bun run web-signer:build
```

### On-chain verification

| What to check | Where to look |
|---|---|
| Transaction submitted | [Sepolia Etherscan](https://sepolia.etherscan.io) — paste tx hash |
| CCIP message delivery status | [CCIP Explorer](https://ccip.chain.link/msg/) — paste message ID |
| Automation upkeep status | [Chainlink Automation Dashboard](https://automation.chain.link) — check upkeep ID, last run, LINK balance |
| Bridge events in CLI | Look for `[bridge:event ...]` lines in CLI terminal output |
| Signer session status | Web-signer UI shows session ID, intent status, and submission result |

---

## 13. Troubleshooting

### Session not found
**Symptom:** CLI says `session not found` or web-signer shows invalid token.  
**Fix:** Restart both the CLI and web-signer. The sessionId and token are generated fresh on each CLI start — the URL printed by the CLI must match the running bridge instance.

### Port already in use
**Symptom:** `Error: address already in use` on CLI start.  
**Fix:**
```bash
ORCHESTRATOR_BRIDGE_PORT=8788 bun run cli:start
```

### OpenAI 429 — quota exceeded
**Symptom:** Workflow logs show `ai_fallback_applied`.  
**What it means:** The AI layer hit rate limits. The workflow automatically falls back to rule-based execution. This is expected behaviour — the system continues operating safely without AI.  
**Fix:** Wait for quota reset or upgrade your OpenAI plan. All workflows are designed to function correctly in fallback mode.

### Funds confusion — LINK vs payload token
**Important distinction:**
- **LINK** = fee token. Pays for CCIP message delivery and Automation upkeep. Always check LINK balance before executing.
- **BnM / your token** = the actual asset being transferred. Separate balance from LINK.

```bash
cast call <contract> "getLinkBalance()" --rpc-url $SEPOLIA_RPC_URL
cast call <contract> "getTokenBalance(address)" <token-addr> --rpc-url $SEPOLIA_RPC_URL
```

### Confidential mode — no tx hash
**Symptom:** Transfer submitted but no transaction hash appears.  
**What it means:** This is correct. Confidential mode uses a private submission path that does not produce a public hash. If you need a verifiable transaction, switch to public mode.

### Automation upkeep not triggering
**Check:**
1. Upkeep is registered and active on [automation.chain.link](https://automation.chain.link)
2. Upkeep has sufficient LINK balance (minimum 5 LINK recommended)
3. `checkUpkeep()` returns `true` — call it directly with `cast call` to verify

---

## 14. Appendix & Glossary

### Configuration files reference

| File | Purpose |
|---|---|
| `workflow.yaml` | CRE workflow targets — staging and production settings |
| `project.yaml` | CRE project config — RPC URLs, chain selectors |
| `config.chainshield.*.json` | ChainShield workflow parameters |
| `config.autopilot.*.json` | AutoPilot DCA workflow parameters |
| `config.crossvault.*.json` | CrossVault workflow parameters |
| `config.chainAlert.intelligence.*.json` | ChainAlert workflow parameters |
| `secrets.yaml` | Root secret declarations (OpenAI key) |
| `secrets.autopilot.yaml` | AutoPilot secret declarations |
| `secrets.chainAlert.intelligence.yaml` | ChainAlert secret declarations |
| `contracts/DEPLOYED_ADDRESSES.md` | **Source of truth** for all deployed contract addresses |

### Supported chains

| Chain | ChainId | Role |
|---|---|---|
| Ethereum Sepolia | 11155111 | Source chain — all contracts deployed here |
| Polygon Amoy | 80002 | Destination chain |
| Arbitrum Sepolia | 421614 | Destination chain |
| Base Sepolia | 84532 | Destination chain |
| Avalanche Fuji | 43113 | Destination chain |

### Glossary

| Term | Definition |
|---|---|
| **CCIP** | Chainlink Cross-Chain Interoperability Protocol — the transport layer that moves tokens and messages between chains |
| **CRE** | Chainlink Runtime Environment — the decentralised compute layer that runs the four workflow files |
| **DON** | Decentralised Oracle Network — the set of Chainlink nodes that reach consensus and execute CRE workflows |
| **Intent** | A typed bundle of transaction parameters built by the CLI and passed to the web-signer for MetaMask approval |
| **Bridge session** | A short-lived authenticated session (sessionId + token) connecting the CLI to the web-signer via SSE |
| **Confidential mode** | A private submission path for ChainShield and CrossVault that does not produce a public transaction hash |
| **PLAN mode** | CrossVault mode where the AI recommends a vault strategy but does not execute any on-chain transaction |
| **EXECUTE mode** | CrossVault mode where the AI recommendation is automatically executed via the programmable sender |
| **Upkeep** | A Chainlink Automation job that triggers `performUpkeep()` on AutomatedTrader on a schedule |
| **ai_fallback_applied** | Log message indicating the AI layer fell back to rule-based execution due to rate limits or unavailability |
