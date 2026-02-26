import type {AutoPilotRequest, GeminiDecision} from "./autopilot.types";

export function buildDecisionNotification(
  decision: GeminiDecision,
  request: AutoPilotRequest,
  requestId: string
): string {
  return [
    `AutoPilot DCA decision`,
    `requestId=${requestId}`,
    `action=${decision.action}`,
    `confidence=${decision.confidence}`,
    `reason=${decision.reason}`,
    `mode=${request.executionMode}`,
    `user=${request.user}`,
    `token=${request.token}`,
    `amount=${request.amount}`
  ].join(" | ");
}

export function buildExecutionNotification(
  requestId: string,
  txHash?: string
): string {
  const suffix = txHash ? ` | txHash=${txHash}` : "";
  return `AutoPilot DCA execution submitted | requestId=${requestId}${suffix}`;
}

export function buildBlockedNotification(
  requestId: string,
  reasonCode: string
): string {
  return `AutoPilot DCA blocked | requestId=${requestId} | reason=${reasonCode}`;
}

