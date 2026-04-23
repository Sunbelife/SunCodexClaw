#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_SCRIPT="${REPO_DIR}/tools/feishu_ws_bot.js"
CTL_SCRIPT="${REPO_DIR}/tools/feishu_bot_ctl.sh"
RUNTIME_DIR="${REPO_DIR}/.runtime/feishu"
LOG_DIR="${RUNTIME_DIR}/logs"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PATH_VALUE="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
CODEX_HOME_VALUE="${CODEX_HOME:-${HOME}/.codex}"
OPENAI_API_KEY_VALUE="${OPENAI_API_KEY:-}"
CODEX_API_KEY_VALUE="${CODEX_API_KEY:-}"
ZEROCHAT_API_KEY_VALUE="${ZEROCHAT_API_KEY:-}"
NODE_TLS_REJECT_UNAUTHORIZED_VALUE="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"
LAUNCHCTL_PREFIX="${SUNCODEXCLAW_LAUNCHCTL_PREFIX:-com.sunbelife.suncodexclaw.feishu}"

usage() {
  cat <<'USAGE'
Usage:
  bash tools/install_feishu_launchagents.sh install [account|all]
  bash tools/install_feishu_launchagents.sh uninstall [account|all]
  bash tools/install_feishu_launchagents.sh status [account|all]

Notes:
  - account defaults to all
  - launch agents are installed to ~/Library/LaunchAgents
  - each account gets a dedicated com.sunbelife.suncodexclaw.feishu.<account> plist
USAGE
}

ensure_bin() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "[error] required binary not found: ${name}" >&2
    exit 1
  fi
}

list_accounts() {
  bash "${CTL_SCRIPT}" list
}

resolve_accounts() {
  local target="${1:-all}"
  if [[ "${target}" == "all" ]]; then
    list_accounts
    return 0
  fi
  printf '%s\n' "${target}"
}

label_for_account() {
  printf '%s.%s\n' "${LAUNCHCTL_PREFIX}" "$1"
}

plist_for_account() {
  printf '%s/%s.plist\n' "${PLIST_DIR}" "$(label_for_account "$1")"
}

log_for_account() {
  printf '%s/%s.log\n' "${LOG_DIR}" "$1"
}

xml_escape_attr() {
  xml_escape "$1"
}

xml_escape() {
  local value="${1:-}"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "${value}"
}

write_plist() {
  local account="$1"
  local label plist_path log_path shell_cmd env_exports
  label="$(label_for_account "${account}")"
  plist_path="$(plist_for_account "${account}")"
  log_path="$(log_for_account "${account}")"

  mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

  env_exports=''
  if [[ -n "${ZEROCHAT_API_KEY_VALUE}" ]]; then
    env_exports="${env_exports} export ZEROCHAT_API_KEY=$(printf '%q' "${ZEROCHAT_API_KEY_VALUE}");"
  fi
  if [[ -n "${OPENAI_API_KEY_VALUE}" ]]; then
    env_exports="${env_exports} export OPENAI_API_KEY=$(printf '%q' "${OPENAI_API_KEY_VALUE}");"
  fi
  if [[ -n "${CODEX_API_KEY_VALUE}" ]]; then
    env_exports="${env_exports} export CODEX_API_KEY=$(printf '%q' "${CODEX_API_KEY_VALUE}");"
  fi
  if [[ -n "${CODEX_HOME_VALUE}" ]]; then
    env_exports="${env_exports} export CODEX_HOME=$(printf '%q' "${CODEX_HOME_VALUE}");"
  fi
  shell_cmd="export NODE_TLS_REJECT_UNAUTHORIZED=$(printf '%q' "${NODE_TLS_REJECT_UNAUTHORIZED_VALUE}"); export PATH=$(printf '%q' "${PATH_VALUE}");${env_exports} cd $(printf '%q' "${REPO_DIR}"); exec $(printf '%q' "${NODE_BIN}") $(printf '%q' "${BOT_SCRIPT}") --account $(printf '%q' "${account}")"

  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "${label}")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>$(xml_escape "${shell_cmd}")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${REPO_DIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "${PATH_VALUE}")</string>
    <key>HOME</key>
    <string>$(xml_escape "${HOME}")</string>
    <key>CODEX_HOME</key>
    <string>$(xml_escape "${CODEX_HOME_VALUE}")</string>
    <key>NODE_TLS_REJECT_UNAUTHORIZED</key>
    <string>$(xml_escape "${NODE_TLS_REJECT_UNAUTHORIZED_VALUE}")</string>
    <key>FEISHU_CODEX_BIN</key>
    <string>$(xml_escape "${CODEX_BIN}")</string>
    <key>OPENAI_API_KEY</key>
    <string>$(xml_escape "${OPENAI_API_KEY_VALUE}")</string>
    <key>CODEX_API_KEY</key>
    <string>$(xml_escape "${CODEX_API_KEY_VALUE}")</string>
    <key>ZEROCHAT_API_KEY</key>
    <string>$(xml_escape "${ZEROCHAT_API_KEY_VALUE}")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${log_path}")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${log_path}")</string>
</dict>
</plist>
EOF

  plutil -lint "${plist_path}" >/dev/null
}

bootout_label() {
  local label="$1"
  launchctl bootout "gui/${UID}/${label}" >/dev/null 2>&1 || true
  launchctl remove "${label}" >/dev/null 2>&1 || true
}

wait_for_absent() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if ! launchctl print "gui/${UID}/${label}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
}

bootstrap_with_retry() {
  local plist_path="$1"
  local output=""
  local attempt
  for attempt in 1 2 3 4 5; do
    if output="$(launchctl bootstrap "gui/${UID}" "${plist_path}" 2>&1)"; then
      return 0
    fi
    sleep 1
  done
  [[ -n "${output}" ]] && echo "${output}" >&2
  return 1
}

install_one() {
  local account="$1"
  local label plist_path
  label="$(label_for_account "${account}")"
  plist_path="$(plist_for_account "${account}")"

  write_plist "${account}"
  bootout_label "${label}"
  wait_for_absent "${label}"
  bootstrap_with_retry "${plist_path}"
  launchctl enable "gui/${UID}/${label}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${label}" >/dev/null 2>&1 || true
  echo "[ok] installed ${account} plist=${plist_path}"
}

uninstall_one() {
  local account="$1"
  local label plist_path
  label="$(label_for_account "${account}")"
  plist_path="$(plist_for_account "${account}")"

  bootout_label "${label}"
  rm -f "${plist_path}"
  echo "[ok] uninstalled ${account} plist=${plist_path}"
}

status_one() {
  local account="$1"
  local label plist_path
  label="$(label_for_account "${account}")"
  plist_path="$(plist_for_account "${account}")"

  if launchctl print "gui/${UID}/${label}" >/dev/null 2>&1; then
    echo "[loaded] ${account} plist=${plist_path}"
    return 0
  fi
  if [[ -f "${plist_path}" ]]; then
    echo "[file-only] ${account} plist=${plist_path}"
    return 0
  fi
  echo "[missing] ${account} plist=${plist_path}"
}

main() {
  local action="${1:-install}"
  local target="${2:-all}"
  local account

  ensure_bin "node" "${NODE_BIN}"
  ensure_bin "codex" "${CODEX_BIN}"

  case "${action}" in
    install)
      while IFS= read -r account; do
        [[ -n "${account}" ]] || continue
        install_one "${account}"
      done < <(resolve_accounts "${target}")
      ;;
    uninstall)
      while IFS= read -r account; do
        [[ -n "${account}" ]] || continue
        uninstall_one "${account}"
      done < <(resolve_accounts "${target}")
      ;;
    status)
      while IFS= read -r account; do
        [[ -n "${account}" ]] || continue
        status_one "${account}"
      done < <(resolve_accounts "${target}")
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "[error] unknown action: ${action}" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
