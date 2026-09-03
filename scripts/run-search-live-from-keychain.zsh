#!/bin/zsh
set -euo pipefail
set +x
unset HISTFILE

# Phase 1 accepts exactly one mode: metaso-shape. Anything else fails BEFORE
# security or npm is reached; no value is ever echoed.
if [[ $# -ne 1 || "$1" != "metaso-shape" ]]; then
  exit 2
fi

METASO_SEARCH_API_KEY="$(security find-generic-password \
  -a deepfield \
  -s com.deepfield.benchmark.metaso \
  -w)"

# Empty or whitespace-only secret: reject silently, never echo the value.
if [[ -z "${METASO_SEARCH_API_KEY//[[:space:]]/}" ]]; then
  exit 1
fi

export METASO_SEARCH_API_KEY
export DEEPFIELD_SEARCH_PROVIDERS=baidu,zhipu,metaso,tavily,serper

exec npm run test:metaso-shape:live
