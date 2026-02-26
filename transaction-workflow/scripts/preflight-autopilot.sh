#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-staging}"
if [[ "${MODE}" != "staging" && "${MODE}" != "production" ]]; then
  echo "usage: $0 [staging|production]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG_FILE="${ROOT_DIR}/transaction-workflow/config.autopilot.${MODE}.json"

if [[ ! -f "${CFG_FILE}" ]]; then
  echo "config not found: ${CFG_FILE}"
  exit 1
fi

if ! command -v cre >/dev/null 2>&1; then
  echo "cre CLI is not installed in PATH"
  exit 1
fi

REQUIRED_CLI_VERSION="$(grep -oE '"requiredCreCliVersion"\s*:\s*"[^"]+"' "${CFG_FILE}" | sed -E 's/.*"([^"]+)"$/\1/' || true)"
CURRENT_CLI_VERSION="$(cre version 2>/dev/null | awk '{print $3}' | sed 's/^v//' || true)"

if [[ -n "${REQUIRED_CLI_VERSION}" && -n "${CURRENT_CLI_VERSION}" ]]; then
  MIN="${REQUIRED_CLI_VERSION#v}"
  CUR="${CURRENT_CLI_VERSION#v}"
  if [[ "$(printf '%s\n%s\n' "${MIN}" "${CUR}" | sort -V | head -n1)" != "${MIN}" ]]; then
    echo "cre CLI version too old: current=${CUR}, required>=${MIN}"
    exit 1
  fi
fi

CFG_KEY="$(grep -oE '"geminiApiKey"\s*:\s*"[^"]*"' "${CFG_FILE}" | sed -E 's/.*"([^"]*)"$/\1/' || true)"
if [[ -n "${CFG_KEY}" ]]; then
  echo "security check failed: geminiApiKey must be empty in ${CFG_FILE}"
  exit 1
fi

ENV_KEY="${GEMINI_API_KEY:-}"
if [[ -z "${ENV_KEY}" && -f "${ROOT_DIR}/.env" ]]; then
  ENV_KEY="$(grep -E '^GEMINI_API_KEY=' "${ROOT_DIR}/.env" | head -n1 | cut -d= -f2- || true)"
fi

if [[ -z "${ENV_KEY}" ]]; then
  echo "missing GEMINI_API_KEY in shell env or ${ROOT_DIR}/.env"
  exit 1
fi

if ! command -v bunx >/dev/null 2>&1; then
  echo "bunx not found; skipping TypeScript check"
else
  (cd "${ROOT_DIR}/transaction-workflow" && bunx tsc --noEmit >/dev/null)
fi

echo "autopilot preflight passed (${MODE})"
