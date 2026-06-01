#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${LABEL:-com.sunbelife.suncodexclaw.feishu.fei-cxp.morning-brief}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
HOUR="${HOUR:-8}"
MINUTE="${MINUTE:-0}"
ACCOUNT="${ACCOUNT:-fei-cxp}"
LOG_DIR="${REPO_DIR}/.runtime/feishu/logs"
LOG_PATH="${LOG_DIR}/changxianpai-morning-brief.log"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO_DIR}/tools/changxianpai_morning_brief.js</string>
    <string>--account</string>
    <string>${ACCOUNT}</string>
    <string>--send</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>NODE_TLS_REJECT_UNAUTHORIZED</key>
    <string>0</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${HOUR}</integer>
    <key>Minute</key>
    <integer>${MINUTE}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

plutil -lint "${PLIST_PATH}" >/dev/null
launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true

echo "INSTALLED ${LABEL}"
echo "plist=${PLIST_PATH}"
echo "log=${LOG_PATH}"
