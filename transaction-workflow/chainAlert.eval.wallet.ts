import type {Feature4AlertType, Feature4RuleEvalResult, Feature4RuleOnchain} from "./chainAlert.intelligence.types";
import {
  deterministicFingerprint,
  normalizeAddress,
  numberFrom,
  parseRuleParams,
  stringArrayFrom,
  stringFrom
} from "./chainAlert.eval.shared";

export type WalletTransfer = {
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenDecimal: string;
  timeStamp: string;
};

type WalletTransfersLookup = (wallet: string, lookbackMinutes: number) => WalletTransfer[];
type TokenPriceLookup = (token: string) => number | undefined;

function parseAmount(value: string, decimalsRaw: string): number {
  const amount = Number(value);
  const decimals = Number(decimalsRaw);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  if (!Number.isFinite(decimals) || decimals < 0) return amount;
  return amount / 10 ** decimals;
}

function evaluateLargeOutflow(
  rule: Feature4RuleOnchain,
  transfersLookup: WalletTransfersLookup,
  priceLookup: TokenPriceLookup
): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const wallet = normalizeAddress(stringFrom(params.wallet));
  const windowMinutes = Math.max(1, numberFrom(params.windowMinutes, 60));
  const thresholdUsd = Math.max(0, numberFrom(params.thresholdUsd, 10000));

  const transfers = transfersLookup(wallet, windowMinutes);
  let outflowUsd = 0;
  for (const t of transfers) {
    if (normalizeAddress(t.from) !== wallet) continue;
    const token = normalizeAddress(t.contractAddress);
    const price = priceLookup(token) ?? 0;
    outflowUsd += parseAmount(t.value, t.tokenDecimal) * price;
  }

  return {
    conditionMet: outflowUsd >= thresholdUsd,
    metric: outflowUsd.toFixed(2),
    fingerprint: deterministicFingerprint([rule.ruleId, wallet, "outflow", outflowUsd.toFixed(2)]),
    reason: outflowUsd >= thresholdUsd ? "WALLET_LARGE_OUTFLOW_BREACHED" : "WALLET_LARGE_OUTFLOW_OK",
    details: {wallet, windowMinutes, thresholdUsd, outflowUsd, transferCount: transfers.length}
  };
}

function evaluateInteractionWithFlagged(
  rule: Feature4RuleOnchain,
  transfersLookup: WalletTransfersLookup
): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const wallet = normalizeAddress(stringFrom(params.wallet));
  const windowMinutes = Math.max(1, numberFrom(params.windowMinutes, 60));
  const flagged = new Set(stringArrayFrom(params.flaggedAddresses).map(normalizeAddress));

  const transfers = transfersLookup(wallet, windowMinutes);
  const hit = transfers.find((t) => flagged.has(normalizeAddress(t.from)) || flagged.has(normalizeAddress(t.to)));

  if (!hit) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, wallet, "flagged_ok"]),
      reason: "WALLET_INTERACTION_WITH_FLAGGED_OK",
      details: {wallet, windowMinutes, transferCount: transfers.length}
    };
  }

  const counterparty = normalizeAddress(hit.from) === wallet ? normalizeAddress(hit.to) : normalizeAddress(hit.from);
  return {
    conditionMet: true,
    metric: "1",
    fingerprint: deterministicFingerprint([rule.ruleId, wallet, "flagged", counterparty]),
    reason: "WALLET_INTERACTION_WITH_FLAGGED_DETECTED",
    details: {wallet, counterparty, flaggedListSize: flagged.size}
  };
}

function evaluateNewTokenReceived(
  rule: Feature4RuleOnchain,
  transfersLookup: WalletTransfersLookup
): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const wallet = normalizeAddress(stringFrom(params.wallet));
  const windowMinutes = Math.max(1, numberFrom(params.windowMinutes, 60));
  const knownTokens = new Set(stringArrayFrom(params.knownTokens).map(normalizeAddress));

  const transfers = transfersLookup(wallet, windowMinutes);
  const incomingUnknown = transfers.find(
    (t) => normalizeAddress(t.to) === wallet && !knownTokens.has(normalizeAddress(t.contractAddress))
  );

  if (!incomingUnknown) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, wallet, "new_token_ok"]),
      reason: "WALLET_NEW_TOKEN_RECEIVED_OK",
      details: {wallet, windowMinutes, knownTokenCount: knownTokens.size}
    };
  }

  const token = normalizeAddress(incomingUnknown.contractAddress);
  return {
    conditionMet: true,
    metric: "1",
    fingerprint: deterministicFingerprint([rule.ruleId, wallet, "new_token", token]),
    reason: "WALLET_NEW_TOKEN_RECEIVED_DETECTED",
    details: {wallet, token, txFrom: incomingUnknown.from, knownTokenCount: knownTokens.size}
  };
}

export function evaluateWalletCategory(
  alertType: Feature4AlertType,
  rule: Feature4RuleOnchain,
  deps: {
    walletTransfersLookup: WalletTransfersLookup;
    tokenPriceLookup: TokenPriceLookup;
  }
): Feature4RuleEvalResult | undefined {
  if (alertType === "WALLET_LARGE_OUTFLOW") {
    return evaluateLargeOutflow(rule, deps.walletTransfersLookup, deps.tokenPriceLookup);
  }
  if (alertType === "WALLET_INTERACTION_WITH_FLAGGED") {
    return evaluateInteractionWithFlagged(rule, deps.walletTransfersLookup);
  }
  if (alertType === "WALLET_NEW_TOKEN_RECEIVED") {
    return evaluateNewTokenReceived(rule, deps.walletTransfersLookup);
  }
  return undefined;
}
