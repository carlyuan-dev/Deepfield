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
  provider-contract|search-benchmark)
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

if [[ "$mode" == "metaso-shape" ]]; then
  METASO_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.metaso)"
  export METASO_SEARCH_API_KEY
  export DEEPFIELD_SEARCH_PROVIDERS=baidu,zhipu,metaso,tavily,serper
  exec npm run test:metaso-shape:live
fi

# Five explicit keychain reads (fixed account deepfield, fixed services).
BAIDU_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.baidu)"
ZHIPU_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.zhipu)"
METASO_SEARCH_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.metaso)"
TAVILY_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.tavily)"
SERPER_API_KEY="$(keychain_secret deepfield com.deepfield.benchmark.serper)"

export BAIDU_SEARCH_API_KEY
export ZHIPU_SEARCH_API_KEY
export METASO_SEARCH_API_KEY
export TAVILY_API_KEY
export SERPER_API_KEY
export DEEPFIELD_SEARCH_PROVIDERS=baidu,zhipu,metaso,tavily,serper

# DEEPFIELD_SEARCH_PRICING is inherited byte-for-byte from the caller; the live
# TypeScript boundary parses it strictly. No echo/print/env/eval or secret argv.
if [[ "$mode" == "provider-contract" ]]; then
  exec npm run test:providers:live
fi
exec npm run benchmark:search
