#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="${SCRIPT_DIR}"
REPO_DIR="$(cd "${PACKAGE_DIR}/../.." && pwd)"
PRODUCT_NAME="SunCodexClawStudio"
APP_NAME="SunCodexClaw Studio"
APP_DIR="${PACKAGE_DIR}/dist/${APP_NAME}.app"
EXECUTABLE="${PRODUCT_NAME}"
RUNTIME_TEMPLATE_DIR="${APP_DIR}/Contents/Resources/RuntimeTemplate"

swift build -c release --package-path "${PACKAGE_DIR}"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"

cp "${PACKAGE_DIR}/.build/release/${EXECUTABLE}" "${APP_DIR}/Contents/MacOS/${EXECUTABLE}"
chmod +x "${APP_DIR}/Contents/MacOS/${EXECUTABLE}"

mkdir -p \
  "${RUNTIME_TEMPLATE_DIR}/config/feishu" \
  "${RUNTIME_TEMPLATE_DIR}/config/secrets" \
  "${RUNTIME_TEMPLATE_DIR}/.runtime/feishu/logs" \
  "${RUNTIME_TEMPLATE_DIR}/.runtime/feishu/pids"

rsync -a --delete \
  "${REPO_DIR}/tools/" \
  "${RUNTIME_TEMPLATE_DIR}/tools/"

rsync -a --delete \
  "${REPO_DIR}/node_modules/" \
  "${RUNTIME_TEMPLATE_DIR}/node_modules/"

cp "${REPO_DIR}/package.json" "${RUNTIME_TEMPLATE_DIR}/package.json"
cp "${REPO_DIR}/package-lock.json" "${RUNTIME_TEMPLATE_DIR}/package-lock.json"
cp "${REPO_DIR}/config/feishu/default.json" "${RUNTIME_TEMPLATE_DIR}/config/feishu/default.json"
cp "${REPO_DIR}/config/feishu/default.example.json" "${RUNTIME_TEMPLATE_DIR}/config/feishu/default.example.json"
cp "${REPO_DIR}/config/secrets/local.example.yaml" "${RUNTIME_TEMPLATE_DIR}/config/secrets/local.example.yaml"
printf 'config:\n  feishu: {}\n' > "${RUNTIME_TEMPLATE_DIR}/config/secrets/local.yaml"

cat > "${APP_DIR}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key>
  <string>com.sunbelife.suncodexclaw.studio</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.3.0</string>
  <key>CFBundleVersion</key>
  <string>3</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

echo "${APP_DIR}"
