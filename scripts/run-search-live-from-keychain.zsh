#!/bin/zsh
set -euo pipefail
set +x
unset HISTFILE

# Exactly one allowlisted mode; anything else fails BEFORE security or npm.
if [[ $# -ne 1 ]]; then
  exit 2
fi

mode="$1"

case "$mode" in
  provider-contract|provider-contract-overseas|search-benchmark)
    # pricing gate BEFORE any Keychain read; inherited raw, never parsed/printed here
    pricing="${DEEPFIELD_SEARCH_PRICING:-}"
    if [[ -z "${pricing//[[:space:]]/}" ]]; then
      exit 3
    fi
    ;;
  metaso-shape)
    ;;
  *)
    exit 2
    ;;
esac

# Reads one explicit account/service pair; command failure, empty or
# whitespace-only results stop the whole launch silently (npm never runs and
# later services are never queried).
keychain_secret() {
  local account="$1"
  local service="$2"
  local value
  value="$(security find-generic-password -a "$account" -s "$service" -w)" || exit 1
  if [[ -z "${value//[[:space:]]/}" ]]; then
    exit 1
  fi
  print -r -- "$value"
}

# The scope env is launcher-owned: any caller-injected value is cleared for the
# full suites so they can never be downgraded to the overseas pair.
unset DEEPFIELD_SEARCH_CONTRACT_SCOPE

if [[ "$mode" == "metaso-shape" ]]; then
  METASO_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.metaso)"
  export METASO_SEARCH_API_KEY
  export DEEPFIELD_SEARCH_PROVIDERS=baidu,metaso,tavily,serper
  exec npm run test:metaso-shape:live
fi

# Five explicit keychain reads (fixed account deepfield, fixed services).
BAIDU_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.baidu)"
METASO_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.metaso)"
TAVILY_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.tavily)"
SERPER_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.serper)"

export BAIDU_SEARCH_API_KEY
export METASO_SEARCH_API_KEY
export TAVILY_API_KEY
export SERPER_API_KEY
export DEEPFIELD_SEARCH_PROVIDERS=baidu,metaso,tavily,serper

# DEEPFIELD_SEARCH_PRICING is inherited byte-for-byte from the caller; the live
# TypeScript boundary parses it strictly. No echo/print/env/eval or secret argv.
case "$mode" in
  provider-contract)
    exec npm run test:providers:live
    ;;
  provider-contract-overseas)
    # fixed overseas scope: ONLY tavily and serper run inside the shared suite
    export DEEPFIELD_SEARCH_CONTRACT_SCOPE=overseas
    exec npm run test:providers:live
    ;;
  search-benchmark)
    exec npm run benchmark:search
    ;;
esac
