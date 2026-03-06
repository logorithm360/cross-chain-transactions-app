import type {Feature4AlertType, Feature4RuleEvalResult, Feature4RuleOnchain} from "./chainAlert.intelligence.types";
import {deterministicFingerprint, numberFrom, parseRuleParams} from "./chainAlert.eval.shared";

type Position = {
  token: string;
  amount: number;
};

type PriceLookup = (token: string) => number | undefined;

function readPositions(params: Record<string, unknown>): Position[] {
  const raw = params.positions;
  if (!Array.isArray(raw)) return [];

  const out: Position[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const token = String(row.token ?? "");
    const amount = numberFrom(row.amount, 0);
    if (!token || amount <= 0) continue;
    out.push({token, amount});
  }
  return out;
}

function portfolioValueUsd(positions: Position[], lookup: PriceLookup): number {
  let total = 0;
  for (const p of positions) {
    const price = lookup(p.token);
    if (!price || price <= 0) continue;
    total += p.amount * price;
  }
  return total;
}

function evaluateDropPercent(rule: Feature4RuleOnchain, lookup: PriceLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const thresholdPct = numberFrom(params.thresholdPct, 0.15);
  const baselineUsd = numberFrom(params.baselineUsd, 0);
  const positions = readPositions(params);
  const currentUsd = portfolioValueUsd(positions, lookup);

  if (baselineUsd <= 0 || currentUsd <= 0) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "missing-baseline"]),
      reason: "PORTFOLIO_BASELINE_MISSING",
      details: {baselineUsd, currentUsd, thresholdPct, positionsCount: positions.length}
    };
  }

  const dropPct = (baselineUsd - currentUsd) / baselineUsd;
  return {
    conditionMet: dropPct >= thresholdPct,
    metric: dropPct.toFixed(6),
    fingerprint: deterministicFingerprint([rule.ruleId, "drop_pct", dropPct.toFixed(4)]),
    reason: dropPct >= thresholdPct ? "PORTFOLIO_DROP_PERCENT_BREACHED" : "PORTFOLIO_DROP_PERCENT_OK",
    details: {baselineUsd, currentUsd, thresholdPct, dropPct}
  };
}

function evaluateDropAbsolute(rule: Feature4RuleOnchain, lookup: PriceLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const thresholdUsd = numberFrom(params.thresholdUsd, 0);
  const baselineUsd = numberFrom(params.baselineUsd, 0);
  const positions = readPositions(params);
  const currentUsd = portfolioValueUsd(positions, lookup);

  const dropUsd = Math.max(0, baselineUsd - currentUsd);
  return {
    conditionMet: thresholdUsd > 0 && dropUsd >= thresholdUsd,
    metric: dropUsd.toFixed(2),
    fingerprint: deterministicFingerprint([rule.ruleId, "drop_abs", dropUsd.toFixed(2)]),
    reason: dropUsd >= thresholdUsd ? "PORTFOLIO_DROP_ABSOLUTE_BREACHED" : "PORTFOLIO_DROP_ABSOLUTE_OK",
    details: {baselineUsd, currentUsd, thresholdUsd, dropUsd}
  };
}

function evaluateTokenConcentration(rule: Feature4RuleOnchain, lookup: PriceLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const threshold = numberFrom(params.threshold, 0.5);
  const positions = readPositions(params);
  const totalUsd = portfolioValueUsd(positions, lookup);

  if (totalUsd <= 0) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "conc_zero"]),
      reason: "TOKEN_CONCENTRATION_NO_DATA",
      details: {threshold, totalUsd}
    };
  }

  let maxShare = 0;
  let dominantToken = "";
  for (const p of positions) {
    const price = lookup(p.token);
    if (!price || price <= 0) continue;
    const share = (p.amount * price) / totalUsd;
    if (share > maxShare) {
      maxShare = share;
      dominantToken = p.token;
    }
  }

  return {
    conditionMet: maxShare >= threshold,
    metric: maxShare.toFixed(6),
    fingerprint: deterministicFingerprint([rule.ruleId, "token_conc", dominantToken, maxShare.toFixed(4)]),
    reason: maxShare >= threshold ? "TOKEN_CONCENTRATION_BREACHED" : "TOKEN_CONCENTRATION_OK",
    details: {dominantToken, maxShare, threshold, totalUsd}
  };
}

export function evaluatePortfolioCategory(
  alertType: Feature4AlertType,
  rule: Feature4RuleOnchain,
  lookup: PriceLookup
): Feature4RuleEvalResult | undefined {
  if (alertType === "PORTFOLIO_DROP_PERCENT") return evaluateDropPercent(rule, lookup);
  if (alertType === "PORTFOLIO_DROP_ABSOLUTE") return evaluateDropAbsolute(rule, lookup);
  if (alertType === "TOKEN_CONCENTRATION") return evaluateTokenConcentration(rule, lookup);
  return undefined;
}
