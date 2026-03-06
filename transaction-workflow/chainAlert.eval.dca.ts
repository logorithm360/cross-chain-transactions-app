import type {Feature4AlertType, Feature4RuleEvalResult, Feature4RuleOnchain} from "./chainAlert.intelligence.types";
import {deterministicFingerprint, numberFrom, parseRuleParams} from "./chainAlert.eval.shared";

export type DcaOrderSnapshot = {
  orderId: number;
  dcaStatus: number;
  executionsRemainingFunded: number;
  lastPendingMessageIds: string[];
  lastFailedMessageIds: string[];
  lastExecutedAt: number;
};

type DcaLookup = (orderId: number) => DcaOrderSnapshot | undefined;

function orderIdsFromParams(params: Record<string, unknown>): number[] {
  if (!Array.isArray(params.orderIds)) return [];
  const ids: number[] = [];
  for (const item of params.orderIds) {
    const id = numberFrom(item, -1);
    if (id >= 0) ids.push(id);
  }
  return ids;
}

function hasNonZero(ids: string[]): boolean {
  return ids.some((x) => x !== "0x0000000000000000000000000000000000000000000000000000000000000000");
}

function failedMessageFingerprint(order: DcaOrderSnapshot): string {
  return order.lastFailedMessageIds.join(",");
}

function pendingMessageFingerprint(order: DcaOrderSnapshot): string {
  return order.lastPendingMessageIds.join(",");
}

function selectOrders(rule: Feature4RuleOnchain, lookup: DcaLookup): DcaOrderSnapshot[] {
  const params = parseRuleParams(rule.paramsJson);
  const ids = orderIdsFromParams(params);
  const out: DcaOrderSnapshot[] = [];
  for (const id of ids) {
    const order = lookup(id);
    if (order) out.push(order);
  }
  return out;
}

function evaluateOrderFailed(rule: Feature4RuleOnchain, lookup: DcaLookup): Feature4RuleEvalResult {
  const orders = selectOrders(rule, lookup);
  const failed = orders.find((x) => hasNonZero(x.lastFailedMessageIds));
  if (!failed) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "dca_failed_none"]),
      reason: "DCA_ORDER_FAILED_OK",
      details: {ordersChecked: orders.length}
    };
  }

  return {
    conditionMet: true,
    metric: "1",
    fingerprint: deterministicFingerprint([rule.ruleId, failed.orderId, failedMessageFingerprint(failed)]),
    reason: "DCA_ORDER_FAILED_DETECTED",
    details: {orderId: failed.orderId, failedMessageIds: failed.lastFailedMessageIds}
  };
}

function evaluateLowFunds(rule: Feature4RuleOnchain, lookup: DcaLookup): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const threshold = numberFrom(params.threshold, 3);
  const orders = selectOrders(rule, lookup);
  const low = orders.find((x) => x.executionsRemainingFunded < threshold);

  if (!low) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "dca_lowfunds_ok"]),
      reason: "DCA_LOW_FUNDS_OK",
      details: {threshold, ordersChecked: orders.length}
    };
  }

  return {
    conditionMet: true,
    metric: String(low.executionsRemainingFunded),
    fingerprint: deterministicFingerprint([rule.ruleId, low.orderId, "lowfunds", low.executionsRemainingFunded]),
    reason: "DCA_LOW_FUNDS_BREACHED",
    details: {orderId: low.orderId, threshold, executionsRemainingFunded: low.executionsRemainingFunded}
  };
}

function evaluatePausedByAi(rule: Feature4RuleOnchain, lookup: DcaLookup): Feature4RuleEvalResult {
  const orders = selectOrders(rule, lookup);
  // 4 => PAUSED_BY_WORKFLOW from AutomatedTrader.DCAStatus enum.
  const paused = orders.find((x) => x.dcaStatus === 4);

  if (!paused) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "dca_paused_ok"]),
      reason: "DCA_ORDER_PAUSED_BY_AI_OK",
      details: {ordersChecked: orders.length}
    };
  }

  return {
    conditionMet: true,
    metric: String(paused.dcaStatus),
    fingerprint: deterministicFingerprint([rule.ruleId, paused.orderId, "paused", paused.dcaStatus]),
    reason: "DCA_ORDER_PAUSED_BY_AI_DETECTED",
    details: {orderId: paused.orderId, dcaStatus: paused.dcaStatus}
  };
}

function evaluateExecutionStuck(rule: Feature4RuleOnchain, lookup: DcaLookup, nowTs: number): Feature4RuleEvalResult {
  const params = parseRuleParams(rule.paramsJson);
  const thresholdHours = numberFrom(params.thresholdHours, 2);
  const thresholdSeconds = Math.max(1, Math.floor(thresholdHours * 3600));
  const orders = selectOrders(rule, lookup);

  const stuck = orders.find((x) => {
    const hasPending = hasNonZero(x.lastPendingMessageIds);
    if (!hasPending) return false;
    if (x.lastExecutedAt <= 0) return false;
    return nowTs - x.lastExecutedAt >= thresholdSeconds;
  });

  if (!stuck) {
    return {
      conditionMet: false,
      metric: "0",
      fingerprint: deterministicFingerprint([rule.ruleId, "dca_stuck_ok"]),
      reason: "DCA_EXECUTION_STUCK_OK",
      details: {ordersChecked: orders.length, thresholdHours}
    };
  }

  const ageSeconds = nowTs - stuck.lastExecutedAt;
  return {
    conditionMet: true,
    metric: String(ageSeconds),
    fingerprint: deterministicFingerprint([rule.ruleId, stuck.orderId, "stuck", pendingMessageFingerprint(stuck)]),
    reason: "DCA_EXECUTION_STUCK_DETECTED",
    details: {orderId: stuck.orderId, thresholdHours, ageSeconds, pending: stuck.lastPendingMessageIds}
  };
}

export function evaluateDcaCategory(
  alertType: Feature4AlertType,
  rule: Feature4RuleOnchain,
  deps: {
    dcaLookup: DcaLookup;
    nowTs: number;
  }
): Feature4RuleEvalResult | undefined {
  if (alertType === "DCA_ORDER_FAILED") return evaluateOrderFailed(rule, deps.dcaLookup);
  if (alertType === "DCA_LOW_FUNDS") return evaluateLowFunds(rule, deps.dcaLookup);
  if (alertType === "DCA_ORDER_PAUSED_BY_AI") return evaluatePausedByAi(rule, deps.dcaLookup);
  if (alertType === "DCA_EXECUTION_STUCK") return evaluateExecutionStuck(rule, deps.dcaLookup, deps.nowTs);
  return undefined;
}
