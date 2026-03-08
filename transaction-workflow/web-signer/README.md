# CRE Web Signer

Thin MetaMask web signer for the CLI orchestrator bridge.

## Run

```bash
cd transaction-workflow/web-signer
bun install
bun run dev
```

Then start CLI in another terminal:

```bash
cd transaction-workflow
bun run cli:start
```

When CLI creates a bridge session in MetaMask mode, open the provided URL.
