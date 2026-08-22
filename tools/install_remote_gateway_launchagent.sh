#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GATEWAY_SCRIPT="${REPO_DIR}/tools/remote_gateway.js"
RUNTIME_DIR="${REPO_DIR}/.runtime/remote_gateway"
LOG_PATH="${RUNTIME_DIR}/gateway.log"
PLIST_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.sunbelife.suncodexclaw.remote-gateway"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PATH_VALUE="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

usage() {
  cat <<'USAGE'
Usage:
  bash tools/install_remote_gateway_launchagent.sh install
  bash tools/install_remote_gateway_launchagent.sh uninstall
  bash tools/install_remote_gateway_launchagent.sh restart
  bash tools/install_remote_gateway_launchagent.sh status
  bash tools/install_remote_gateway_launchagent.sh logs
USAGE
}

xml_escape() {
  local value="${1:-}"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "${value}"
}

require_ready() {
  if [[ -z "${NODE_BIN}" ]]; then
    echo "[error] node was not found" >&2
    exit 1
  fi
  if ! "${NODE_BIN}" "${GATEWAY_SCRIPT}" status >/dev/null 2>&1; then
    echo "[error] remote gateway is not configured; run: npm run remote:setup" >&2
    exit 1
  fi
}

write_plist() {
  mkdir -p "${PLIST_DIR}" "${RUNTIME_DIR}"
  cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "${LABEL}")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "${NODE_BIN}")</string>
    <string>$(xml_escape "${GATEWAY_SCRIPT}")</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${REPO_DIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "${PATH_VALUE}")</string>
    <key>HOME</key>
    <string>$(xml_escape "${HOME}")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${LOG_PATH}")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${LOG_PATH}")</string>
</dict>
</plist>
EOF
  plutil -lint "${PLIST_PATH}" >/dev/null
}

bootout() {
  launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  launchctl remove "${LABEL}" >/dev/null 2>&1 || true
}

install_gateway() {
  require_ready
  write_plist
  bootout
  launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
  launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${LABEL}"
  echo "[ok] remote gateway installed: ${PLIST_PATH}"
}

uninstall_gateway() {
  bootout
  rm -f "${PLIST_PATH}"
  echo "[ok] remote gateway uninstalled"
}

status_gateway() {
  if launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
    echo "[running] ${LABEL} log=${LOG_PATH}"
    return 0
  fi
  if [[ -f "${PLIST_PATH}" ]]; then
    echo "[installed-not-running] ${LABEL} plist=${PLIST_PATH}"
    return 1
  fi
  echo "[not-installed] ${LABEL}"
  return 1
}

case "${1:-install}" in
  install)
    install_gateway
    ;;
  uninstall)
    uninstall_gateway
    ;;
  restart)
    require_ready
    if [[ ! -f "${PLIST_PATH}" ]]; then
      install_gateway
    else
      launchctl kickstart -k "gui/${UID}/${LABEL}"
      echo "[ok] remote gateway restarted"
    fi
    ;;
  status)
    status_gateway
    ;;
  logs)
    mkdir -p "${RUNTIME_DIR}"
    touch "${LOG_PATH}"
    tail -n 100 -f "${LOG_PATH}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
