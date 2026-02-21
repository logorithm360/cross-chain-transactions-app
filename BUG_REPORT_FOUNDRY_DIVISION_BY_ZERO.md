# Foundry Bug: Division by Zero Panic When Transactions Drop from Mempool

## Description

Foundry (Forge) crashes with a "division by zero" panic when transactions are dropped from the mempool during script execution with `--broadcast` flag.

## Environment

- **Foundry version**: Latest (fromcrates/script/src/broadcast.rs)
- **OS**: Linux 6.6
- **Chain**: Ethereum Sepolia (chain ID 11155111)
- **Command**: `forge script` with `--broadcast` flag

## Reproduction Steps

1. Run a Forge script with `--broadcast` flag to Sepolia testnet
2. Wait for transactions to be dropped from the mempool (network congestion)
3. Foundry panics with division by zero error

## Expected Behavior

Foundry should handle dropped transactions gracefully, either by:
- Resuming with `--resume` flag
- Providing a meaningful error message
- Retrying automatically

## Actual Behavior

The application panics with:
```
Message:  attempt to divide by zero
Location: /home/runner/work/foundry/foundry/crates/script/src/broadcast.rs:507
```

## Terminal Output (Full)

```
LOCAL_CCIP_ROUTER=0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 \
LOCAL_LINK_TOKEN=0x779877A7B0D9E8603169DdbD7836e478b4624789 \
LOCAL_CCIP_BNM_TOKEN=0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05 \
forge script script/Deployprogrammable.s.sol:DeployProgrammableSender \
  --rpc-url sepolia \
  --account deployer \
  --broadcast \
  -vvvv

[⠒] Compiling...
No files changed, compilation skipped
Enter keystore password:
Traces:
  [1955963] DeployProgrammableSender::run()
    ├─ [0] VM::envAddress("LOCAL_CCIP_ROUTER") [staticcall]
    │   └─ ← [Return] <env var value>
    ├─ [0] VM::envAddress("LOCAL_LINK_TOKEN") [staticcall]
    │   └─ ← [env var value]
    ...
    └─ ← [Return] ProgrammableTokenSender: [0xeD437c19c65f196b35a2D8dd859A22D0F4c98436]

Script ran successfully.

== Return ==
senderContract: contract ProgrammableTokenSender 0xeD437c19c65f196b35a2D8dd859A22D0F4c98436

== Logs ==
  Deploying ProgrammableTokenSender on Ethereum Sepolia
  Chain ID:       11155111
  Chain selector: 16015286601757825753
  Pay fees in:    LINK
  =============================================
  ProgrammableTokenSender deployed at: 0xeD437c19c65f196b35a2D8dd859A22D0F4c98436
  Router:                             0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59
  LINK token:                         0x779877A7B0D9E8603169DdbD7836e478b4624789
  Default programmable gasLimit:      500000
  =============================================

⠂ Sequence #1 on sepolia | Waiting for pending transactions
    ⠂ [Pending] 0x4969958d5ef35ab1330e99e48f98ae959daf7c1371dd6a90c199a5bea42141b3
    ⠁ [Pending] 0x094759588e4f7d791ee7204d7658b098ff5849ad1e670de4f78d1b9726e22222
    ⠁ [Pending] 0xea15b4bd9c8e4a7a0b52192160089cf0d1f96d4a7a26bf1e6bba413f664a5b65
Transaction 0x2f929b0835cccaf7f28915180576729f30d2b431e8fc072e2f0d1c208deb8b64 dropped from the mempool. It will be retried when using --resume.
Transaction 0xea15b4bd9c8e4a7a0b52192160089cf0d1f96d4a7a26bf1e6bba413f664a5b65 dropped from the mempool. It will be retried when using --resume.
Transaction 0xe400e2150a678cddd92221b1e1240c3d54ee293db16c0206865bb73a504a730d dropped from the mempool. It will be retried when using --resume.
...
⠠ Sequence #1 on sepolia | Waiting for pending transactions
    ⠖ [00:00:18] [##########################################################] 8/8 txes (0.0s)
    ⠖ [00:00:18] [------------------------------------------------------] 0/8 receipts (0.0s)
⠐ Sequence #1 on sepolia | Waiting for pending transactions
    ⠒ [00:00:19] [##########################################################] 8/8 txes (0.0s)
    ⠒ [00:00:19] [######################################################] 8/8 receipts (0.0s)The application panicked (crashed).
Message:  attempt to divide by zero
Location: /home/runner/work/foundry/foundry/crates/script/src/broadcast.rs:507

This is a bug. Consider reporting it at https://github.com/foundry-rs/foundry

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ BACKTRACE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                                ⋮ 7 frames hidden ⋮                               
   8: core::panicking::panic_const::panic_const_div_by_zero::h52e672bf116813dc
      at <unknown source file>:<unknown line>
   9: forge_script::broadcast::BundledState::broadcast::{{closure}}::ha3586f5badc732d0
      at <unknown source file>:<unknown line>
  10: forge_script::ScriptArgs::run_script::{{closure}}::hd0375d2413618123
      at <unknown source file>:<unknown line>
  11: forge::args::run_command::hb8b347cfda86b0e4
      at <unknown source file>:<unknown line>
  12: forge::args::run::h53bb636d3b682b0b
      at <unknown source file>:<unknown line>
  13: forge::main::haf3d1ba9c943525d
      at <unknown source file>:<unknown line>
  14: std::sys::backtrace::__rust_begin_short_backtrace::h5b14e53b2d308181
      at <unknown source file>:<unknown line>
  15: main<unknown>
      at <unknown source file>:<unknown line>
   16: __libc_start_main<unknown>
      at <unknown source file>:<unknown line>
   17: _start<unknown>
      at <unknown source file>:<unknown line>

Run with COLORBT_SHOW_HIDDEN=1 environment variable to disable frame filtering.
Run with RUST_BACKTRACE=full to include source snippets.
Aborted (core dumped)
```

## Additional Context

- The script itself executed successfully (transactions were created and broadcast)
- All 8 transactions were initially pending in the mempool
- Multiple transactions were dropped due to network conditions
- The panic occurs when Foundry tries to calculate something (likely gas price ratio or transaction confirmation ratio) after detecting that all transactions were dropped
- The division by zero likely happens because there are 0 receipts for 8 transactions, causing a divide by zero when calculating a ratio

## Suggested Fix

The code at `broadcast.rs:507` should check for zero values before performing division operations, especially when:
- Calculating confirmation ratios (confirmed txes / total txes)
- Calculating gas price adjustments
- Any other ratio calculations involving transaction counts

---

**Tags**: bug, forge, broadcast, mempool, division-by-zero, sepolia

