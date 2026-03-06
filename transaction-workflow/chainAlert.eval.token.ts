import type {Feature4AlertType, Feature4RuleEvalResult, Feature4RuleOnchain} from "./chainAlert.intelligence.types";
import {deterministicFingerprint, numberFrom, parseRuleParams, stringFrom} from "./chainAlert.eval.shared";

export type TokenMarketSnapshot = {
  priceUsd?: number;
  priceChangePct1h?: number;
  liquidityUsd?: number;
};

type TokenStatusLookup = (token: string) => number | undefined;
type TokenMarketLookup = (token: string) => TokenMarketSnapshot | undefined;

function normalizeRatioLikePercent(value: number): number {
  // DexScreener may return either 12 (12%) or 0.12 (12%).
  if (Math.abs(value) > 1.5) return value / 100;
  return value;
}

function evaluateFlagged(rule: Feature4RuleOnchain, statusLookup: TokenStatusLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const token = stringFrom(params.token);
  const status = statusLookup(token);

  const isFlagged = typeof status === "number" && status >= 3;
  return {
    conditionMet: isFlagged,
    metric: String(status ?? -1),
    fingerprint: deterministicFingerprint([rule.ruleId, token, status ?? -1]),
    reason: isFlagged ? "TOKEN_STATUS_FLAGGED" : "TOKEN_STATUS_OK",
    details: {token, status}
  };
}

function evaluatePriceSpike(rule: Feature4RuleOnchain, marketLookup: TokenMarketLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const token = stringFrom(params.token);
  const threshold = numberFrom(params.threshold, 0.2);
  const market = marketLookup(token);
  const pct = normalizeRatioLikePercent(numberFrom(market?.priceChangePct1h, 0));

  return {
    conditionMet: Math.abs(pct) >= threshold,
    metric: pct.toFixed(6),
    fingerprint: deterministicFingerprint([rule.ruleId, token, "spike", pct.toFixed(4)]),
    reason: Math.abs(pct) >= threshold ? "TOKEN_PRICE_SPIKE_BREACHED" : "TOKEN_PRICE_SPIKE_OK",
    details: {token, threshold, pct, market}
  };
}

function evaluateLiquidityDrop(rule: Feature4RuleOnchain, marketLookup: TokenMarketLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const token = stringFrom(params.token);
  const threshold = numberFrom(params.threshold, 0.4);
  const baselineLiquidityUsd = numberFrom(params.baselineLiquidityUsd, 0);
  const market = marketLookup(token);
  const currentLiquidityUsd = numberFrom(market?.liquidityUsd, 0);

  if (baselineLiquidityUsd <= 0 || currentLiquidityUsd <= 0) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, token, "liq_missing"]),
      reason: "TOKEN_LIQUIDITY_DATA_MISSING",
      details: {token, threshold, baselineLiquidityUsd, currentLiquidityUsd}
    };
  }

  const drop = (baselineLiquidityUsd - currentLiquidityUsd) / baselineLiquidityUsd;
  return {
    conditionMet: drop >= threshold,
    metric: drop.toFixed(6),
    fingerprint: deterministicFingerprint([rule.ruleId, token, "liq_drop", drop.toFixed(4)]),
    reason: drop >= threshold ? "TOKEN_LIQUIDITY_DROP_BREACHED" : "TOKEN_LIQUIDITY_DROP_OK",
    details: {token, threshold, drop, baselineLiquidityUsd, currentLiquidityUsd}
  };
}

function evaluateHolderConcentration(rule: Feature4RuleOnchain): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const token = stringFrom(params.token);
  const threshold = numberFrom(params.threshold, 0.8);
  const top10Pct = normalizeRatioLikePercent(numberFrom(params.top10HoldersPctCurrent, 0));

  return {
    conditionMet: top10Pct >= threshold,
    metric: top10Pct.toFixed(6),
    fingerprint: deterministicFingerprint([rule.ruleId, token, "holders", top10Pct.toFixed(4)]),
    reason: top10Pct >= threshold ? "TOKEN_HOLDER_CONCENTRATION_BREACHED" : "TOKEN_HOLDER_CONCENTRATION_OK",
    details: {token, threshold, top10Pct}
  };
}

export function evaluateTokenCategory(
  alertType: Feature4AlertType,
  rule: Feature4RuleOnchain,
  deps: {
    tokenStatusLookup: TokenStatusLookup;
    tokenMarketLookup: TokenMarketLookup;
  }
): Feature4RuleEvalResult | undefined {
  if (alertType === "TOKEN_FLAGGED_SUSPICIOUS") return evaluateFlagged(rule, deps.tokenStatusLookup);
  if (alertType === "TOKEN_PRICE_SPIKE") return evaluatePriceSpike(rule, deps.tokenMarketLookup);
  if (alertType === "TOKEN_LIQUIDITY_DROP") return evaluateLiquidityDrop(rule, deps.tokenMarketLookup);
  if (alertType === "TOKEN_HOLDER_CONCENTRATION") return evaluateHolderConcentration(rule);
  return undefined;
}
