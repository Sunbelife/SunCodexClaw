#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_SCRIPT="${REPO_DIR}/tools/feishu_ws_bot.js"
CONFIG_DIR="${REPO_DIR}/config/feishu"
RUNTIME_DIR="${REPO_DIR}/.runtime/feishu"
PID_DIR="${RUNTIME_DIR}/pids"
LOG_DIR="${RUNTIME_DIR}/logs"
NODE_BIN="${NODE_BIN:-node}"
OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
USE_LAUNCHCTL=false
LAUNCHCTL_PREFIX="${SUNCODEXCLAW_LAUNCHCTL_PREFIX:-com.sunbelife.suncodexclaw.feishu}"
if [[ "${OS_NAME}" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  USE_LAUNCHCTL=true
fi

mkdir -p "${PID_DIR}" "${LOG_DIR}"

usage() {
  cat <<'USAGE'
Usage:
  bash tools/feishu_bot_ctl.sh list
  bash tools/feishu_bot_ctl.sh start [account|all]
  bash tools/feishu_bot_ctl.sh stop [account|all]
  bash tools/feishu_bot_ctl.sh restart [account|all]
  bash tools/feishu_bot_ctl.sh status [account|all]
  bash tools/feishu_bot_ctl.sh logs <account> [--follow]

Notes:
  - account defaults to all for start/stop/restart/status
  - logs requires a single account name
  - on macOS, start/stop/status prefer launchctl for detached background jobs
USAGE
}

resolve_bin_path() {
  local bin="${1:-}"
  if [[ -z "${bin}" ]]; then
    return 1
  fi
  if [[ "${bin}" == */* ]]; then
    printf '%s\n' "${bin}"
    return 0
  fi
  command -v "${bin}" 2>/dev/null || true
}

NODE_BIN_RESOLVED="$(resolve_bin_path "${NODE_BIN}")"
if [[ -z "${NODE_BIN_RESOLVED}" ]]; then
  NODE_BIN_RESOLVED="${NODE_BIN}"
fi

append_export_if_set() {
  local __outvar="$1"
  local key="$2"
  local value="${!key-}"
  [[ -n "${__outvar}" && -n "${key}" ]] || return 0
  if [[ -n "${value}" ]]; then
    printf -v "${__outvar}" '%s export %s=%q;' "${!__outvar-}" "${key}" "${value}"
  fi
}

yaml_config_names() {
  [[ -f "${REPO_DIR}/tools/lib/local_secret_store.js" ]] || return 0
  REPO_DIR_ENV="${REPO_DIR}" "${NODE_BIN_RESOLVED}" - <<'EOF' 2>/dev/null || true
const path = require('path');
const { listConfigEntryNames } = require(path.join(process.env.REPO_DIR_ENV, 'tools', 'lib', 'local_secret_store.js'));
for (const name of listConfigEntryNames('feishu')) {
  if (name === 'default') continue;
  console.log(name);
}
EOF
}

yaml_config_exists() {
  local account="$1"
  [[ -f "${REPO_DIR}/tools/lib/local_secret_store.js" ]] || return 1
  REPO_DIR_ENV="${REPO_DIR}" "${NODE_BIN_RESOLVED}" - "${account}" <<'EOF' >/dev/null 2>&1
const path = require('path');
const account = process.argv[2] || '';
const { readConfigEntry } = require(path.join(process.env.REPO_DIR_ENV, 'tools', 'lib', 'local_secret_store.js'));
const cfg = readConfigEntry('feishu', account, {});
process.exit(cfg && Object.keys(cfg).length > 0 ? 0 : 1);
EOF
}

config_exists_for_account() {
  local account="$1"
  [[ -f "${CONFIG_DIR}/${account}.json" ]] && return 0
  yaml_config_exists "${account}"
}

list_accounts() {
  {
    local f base
    for f in "${CONFIG_DIR}"/*.json; do
      [[ -e "${f}" ]] || continue
      base="$(basename "${f}" .json)"
      [[ "${base}" == "default" ]] && continue
      [[ "${base}" == *.example ]] && continue
      printf '%s\n' "${base}"
    done
    yaml_config_names
  } | awk 'NF && !seen[$0]++' | sort
}

resolve_accounts() {
  local target="${1:-all}"
  local listed
  if [[ "${target}" == "all" ]]; then
    listed="$(list_accounts || true)"
    if [[ -z "${listed//[$'\r\n\t ']}" ]]; then
      echo "[error] no feishu accounts found in ${CONFIG_DIR}" >&2
      exit 1
    fi
    printf '%s\n' "${listed}"
    return 0
  fi
  printf '%s\n' "${target}"
}

pid_file() {
  printf '%s/%s.pid\n' "${PID_DIR}" "$1"
}

log_file() {
  printf '%s/%s.log\n' "${LOG_DIR}" "$1"
}

launchctl_label() {
  printf '%s.%s\n' "${LAUNCHCTL_PREFIX}" "$1"
}

launchctl_job_exists() {
  local account="$1"
  local label
  [[ "${USE_LAUNCHCTL}" == "true" ]] || return 1
  label="$(launchctl_label "${account}")"
  launchctl list "${label}" >/dev/null 2>&1
}

launchctl_job_pid() {
  local account="$1"
  local label raw
  [[ "${USE_LAUNCHCTL}" == "true" ]] || return 1
  label="$(launchctl_label "${account}")"
  raw="$(launchctl list "${label}" 2>/dev/null || true)"
  sed -n 's/.*"PID"[[:space:]]*=[[:space:]]*\([0-9][0-9]*\);/\1/p' <<<"${raw}" | head -n 1
}

launchctl_last_exit_status() {
  local account="$1"
  local label raw
  [[ "${USE_LAUNCHCTL}" == "true" ]] || return 1
  label="$(launchctl_label "${account}")"
  raw="$(launchctl list "${label}" 2>/dev/null || true)"
  sed -n 's/.*"LastExitStatus"[[:space:]]*=[[:space:]]*\([-0-9][0-9]*\);/\1/p' <<<"${raw}" | head -n 1
}

is_launchctl_bot_running() {
  local account="$1"
  local pid
  pid="$(launchctl_job_pid "${account}" || true)"
  is_bot_pid_for_account "${pid}" "${account}"
}

start_one_launchctl() {
  local account="$1"
  local pidf logf label pid cmd env_exports
  pidf="$(pid_file "${account}")"
  logf="$(log_file "${account}")"
  label="$(launchctl_label "${account}")"

  if is_launchctl_bot_running "${account}"; then
    pid="$(launchctl_job_pid "${account}" || true)"
    rm -f "${pidf}"
    echo "[skip] ${account} already running (pid=${pid}, manager=launchctl)"
    return 0
  fi

  if launchctl_job_exists "${account}"; then
    launchctl remove "${label}" 2>/dev/null || true
  fi

  {
    echo "[$(date '+%F %T')] starting account=${account} manager=launchctl"
  } >> "${logf}"

  env_exports=''
  append_export_if_set env_exports ZEROCHAT_API_KEY
  append_export_if_set env_exports OPENAI_API_KEY
  append_export_if_set env_exports CODEX_API_KEY
  append_export_if_set env_exports CODEX_HOME

  printf -v cmd 'export PATH=%q;%s cd %q; exec %q %q --account %q >> %q 2>&1' \
    "${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
    "${env_exports}" \
    "${REPO_DIR}" \
    "${NODE_BIN_RESOLVED}" \
    "${BOT_SCRIPT}" \
    "${account}" \
    "${logf}"
  cmd="export NODE_TLS_REJECT_UNAUTHORIZED=0; ${cmd}"
  launchctl submit -l "${label}" -- /bin/zsh -lc "${cmd}"
  sleep 1

  pid="$(launchctl_job_pid "${account}" || true)"
  if is_bot_pid_for_account "${pid}" "${account}"; then
    rm -f "${pidf}"
    echo "[ok] started ${account} (pid=${pid}, manager=launchctl) log=${logf}"
    return 0
  fi

  echo "[error] failed to start ${account} via launchctl; recent log:" >&2
  tail -n 80 "${logf}" >&2 || true
  launchctl remove "${label}" 2>/dev/null || true
  rm -f "${pidf}"
  return 1
}

stop_one_launchctl() {
  local account="$1"
  local pidf label pid i
  pidf="$(pid_file "${account}")"
  label="$(launchctl_label "${account}")"
  pid="$(launchctl_job_pid "${account}" || true)"

  if ! launchctl_job_exists "${account}"; then
    return 1
  fi

  launchctl remove "${label}" 2>/dev/null || true
  for i in $(seq 1 20); do
    if ! is_running_pid "${pid}"; then
      rm -f "${pidf}"
      echo "[ok] stopped ${account} (pid=${pid:-none}, manager=launchctl)"
      return 0
    fi
    sleep 0.25
  done

  if is_running_pid "${pid}"; then
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${pidf}"
  echo "[ok] force-stopped ${account} (pid=${pid:-none}, manager=launchctl)"
  return 0
}

is_running_pid() {
  local pid="${1:-}"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

is_bot_pid_for_account() {
  local pid="${1:-}"
  local account="${2:-}"
  local cmd
  [[ -n "${account}" ]] || return 1
  is_running_pid "${pid}" || return 1
  cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ "${cmd}" == *"feishu_ws_bot.js --account ${account}"* ]]
}

find_manual_pids() {
  local account="$1"
  local line pid cmd
  ps -ax -o pid=,command= | while IFS= read -r line; do
    pid="$(awk '{print $1}' <<<"${line}")"
    cmd="$(awk '{$1=""; sub(/^ /, ""); print}' <<<"${line}")"
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    if [[ "${cmd}" == *"feishu_ws_bot.js --account ${account}"* ]]; then
      echo "${pid}"
    fi
  done
}

start_one() {
  local account="$1"
  local pidf logf pid cfg manual
  pidf="$(pid_file "${account}")"
  logf="$(log_file "${account}")"
  cfg="${CONFIG_DIR}/${account}.json"

  if ! config_exists_for_account "${account}"; then
    echo "[error] missing config for ${account}: ${cfg} (and no local.yaml entry)" >&2
    return 1
  fi

  if [[ "${USE_LAUNCHCTL}" == "true" ]] && is_launchctl_bot_running "${account}"; then
    pid="$(launchctl_job_pid "${account}" || true)"
    rm -f "${pidf}"
    echo "[skip] ${account} already running (pid=${pid}, manager=launchctl)"
    return 0
  fi

  if [[ -f "${pidf}" ]]; then
    pid="$(cat "${pidf}" 2>/dev/null || true)"
    if is_bot_pid_for_account "${pid}" "${account}"; then
      echo "[skip] ${account} already running (pid=${pid}, manager=pidfile)"
      return 0
    fi
    rm -f "${pidf}"
  fi

  manual="$(find_manual_pids "${account}" | head -n 1)"
  if is_bot_pid_for_account "${manual}" "${account}"; then
    echo "${manual}" > "${pidf}"
    echo "[skip] ${account} already running (pid=${manual}, manager=manual); pid file adopted"
    return 0
  fi

  if [[ "${USE_LAUNCHCTL}" == "true" ]]; then
    if start_one_launchctl "${account}"; then
      return 0
    fi
  fi

  {
    echo "[$(date '+%F %T')] starting account=${account}"
  } >> "${logf}"

  ZEROCHAT_API_KEY="${ZEROCHAT_API_KEY-}" \
  OPENAI_API_KEY="${OPENAI_API_KEY-}" \
  CODEX_API_KEY="${CODEX_API_KEY-}" \
  CODEX_HOME="${CODEX_HOME-}" \
  nohup "${NODE_BIN}" "${BOT_SCRIPT}" --account "${account}" >> "${logf}" 2>&1 &
  pid="$!"
  echo "${pid}" > "${pidf}"
  sleep 1

  if is_bot_pid_for_account "${pid}" "${account}"; then
    echo "[ok] started ${account} (pid=${pid}, manager=pidfile) log=${logf}"
    return 0
  fi

  echo "[error] failed to start ${account}; recent log:" >&2
  tail -n 80 "${logf}" >&2 || true
  rm -f "${pidf}"
  return 1
}

stop_one() {
  local account="$1"
  local pidf pid i manual
  pidf="$(pid_file "${account}")"

  if [[ "${USE_LAUNCHCTL}" == "true" ]]; then
    if stop_one_launchctl "${account}"; then
      return 0
    fi
  fi

  if [[ ! -f "${pidf}" ]]; then
    manual="$(find_manual_pids "${account}" | head -n 1)"
    if is_running_pid "${manual}"; then
      kill "${manual}" 2>/dev/null || true
      echo "[ok] stopped ${account} (pid=${manual}, manager=manual)"
      return 0
    fi
    echo "[skip] ${account} not running (no pid file)"
    return 0
  fi

  pid="$(cat "${pidf}" 2>/dev/null || true)"
  if ! is_bot_pid_for_account "${pid}" "${account}"; then
    rm -f "${pidf}"
    manual="$(find_manual_pids "${account}" | head -n 1)"
    if is_bot_pid_for_account "${manual}" "${account}"; then
      kill "${manual}" 2>/dev/null || true
      echo "[ok] stopped ${account} (pid=${manual}, manager=manual)"
      return 0
    fi
    echo "[skip] ${account} stale pid file removed"
    return 0
  fi

  kill "${pid}" 2>/dev/null || true
  for i in $(seq 1 20); do
    if ! is_running_pid "${pid}"; then
      rm -f "${pidf}"
      echo "[ok] stopped ${account} (pid=${pid}, manager=pidfile)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "${pid}" 2>/dev/null || true
  rm -f "${pidf}"
  echo "[ok] force-stopped ${account} (pid=${pid}, manager=pidfile)"
}

status_one() {
  local account="$1"
  local pidf logf pid manual last_exit
  pidf="$(pid_file "${account}")"
  logf="$(log_file "${account}")"

  if [[ "${USE_LAUNCHCTL}" == "true" ]]; then
    if is_launchctl_bot_running "${account}"; then
      pid="$(launchctl_job_pid "${account}" || true)"
      rm -f "${pidf}"
      echo "[running] ${account} pid=${pid} manager=launchctl log=${logf}"
      return 0
    fi
    if launchctl_job_exists "${account}"; then
      last_exit="$(launchctl_last_exit_status "${account}" || true)"
      echo "[stopped] ${account} pid=(none) manager=launchctl last_exit=${last_exit:-unknown} log=${logf}"
      return 0
    fi
  fi

  if [[ -f "${pidf}" ]]; then
    pid="$(cat "${pidf}" 2>/dev/null || true)"
    if is_bot_pid_for_account "${pid}" "${account}"; then
      echo "[running] ${account} pid=${pid} manager=pidfile log=${logf}"
      return 0
    fi
    manual="$(find_manual_pids "${account}" | head -n 1)"
    if is_bot_pid_for_account "${manual}" "${account}"; then
      echo "${manual}" > "${pidf}"
      echo "[running] ${account} pid=${manual} manager=manual log=${logf}"
      return 0
    fi
    echo "[stopped] ${account} stale_pid=${pid} manager=pidfile log=${logf}"
    return 0
  fi

  manual="$(find_manual_pids "${account}" | head -n 1)"
  if is_running_pid "${manual}"; then
    echo "[running] ${account} pid=${manual} manager=manual log=${logf}"
    return 0
  fi

  echo "[stopped] ${account} pid=(none) log=${logf}"
}

logs_one() {
  local account="$1"
  local follow="${2:-false}"
  local logf
  logf="$(log_file "${account}")"
  if [[ ! -f "${logf}" ]]; then
    echo "[error] log file not found: ${logf}" >&2
    exit 1
  fi
  if [[ "${follow}" == "true" ]]; then
    tail -n 120 -f "${logf}"
  else
    tail -n 120 "${logf}"
  fi
}

ACTION="${1:-}"
TARGET="${2:-all}"
OPT3="${3:-}"

if [[ -z "${ACTION}" ]]; then
  usage
  exit 1
fi

case "${ACTION}" in
  list)
    list_accounts
    ;;
  start)
    while IFS= read -r account; do
      [[ -z "${account}" ]] || start_one "${account}"
    done < <(resolve_accounts "${TARGET}")
    ;;
  stop)
    while IFS= read -r account; do
      [[ -z "${account}" ]] || stop_one "${account}"
    done < <(resolve_accounts "${TARGET}")
    ;;
  restart)
    while IFS= read -r account; do
      [[ -z "${account}" ]] || stop_one "${account}"
    done < <(resolve_accounts "${TARGET}")
    while IFS= read -r account; do
      [[ -z "${account}" ]] || start_one "${account}"
    done < <(resolve_accounts "${TARGET}")
    ;;
  status)
    while IFS= read -r account; do
      [[ -z "${account}" ]] || status_one "${account}"
    done < <(resolve_accounts "${TARGET}")
    ;;
  logs)
    if [[ "${TARGET}" == "all" || -z "${TARGET}" ]]; then
      echo "[error] logs requires one account (example: fei-ls)" >&2
      exit 1
    fi
    if [[ "${OPT3}" == "--follow" || "${OPT3}" == "-f" ]]; then
      logs_one "${TARGET}" "true"
    else
      logs_one "${TARGET}" "false"
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
