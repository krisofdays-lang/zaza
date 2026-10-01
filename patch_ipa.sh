#!/bin/bash
set -euo pipefail

# Patch IPA with dylib injection
# Usage: ./patch_ipa.sh <input.ipa> <tweak.dylib> [output.ipa]

if [ $# -lt 2 ]; then
    echo "Usage: $0 <input.ipa> <tweak.dylib> [output.ipa]"
    echo ""
    echo "Requirements: optool or insert_dylib, ldid or codesign"
    exit 1
fi

INPUT_IPA="$1"
DYLIB="$2"
OUTPUT_IPA="${3:-patched_$(basename "$INPUT_IPA")}"
DYLIB_NAME="$(basename "$DYLIB")"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[*] Extracting IPA..."
unzip -q "$INPUT_IPA" -d "$WORK_DIR"

APP_PATH=$(find "$WORK_DIR/Payload" -maxdepth 1 -name "*.app" -type d | head -1)
if [ -z "$APP_PATH" ]; then
    echo "[!] No .app found in Payload/"
    exit 1
fi

APP_NAME=$(basename "$APP_PATH")
BINARY_NAME="${APP_NAME%.app}"

# Find the actual binary name from Info.plist if possible
if command -v plutil &>/dev/null; then
    PLIST_BINARY=$(plutil -extract CFBundleExecutable raw "$APP_PATH/Info.plist" 2>/dev/null || true)
    if [ -n "$PLIST_BINARY" ]; then
        BINARY_NAME="$PLIST_BINARY"
    fi
elif command -v /usr/libexec/PlistBuddy &>/dev/null; then
    PLIST_BINARY=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_PATH/Info.plist" 2>/dev/null || true)
    if [ -n "$PLIST_BINARY" ]; then
        BINARY_NAME="$PLIST_BINARY"
    fi
fi

BINARY="$APP_PATH/$BINARY_NAME"
if [ ! -f "$BINARY" ]; then
    echo "[!] Binary not found: $BINARY"
    echo "[*] Files in app bundle:"
    ls "$APP_PATH/"
    exit 1
fi

echo "[*] App: $APP_NAME"
echo "[*] Binary: $BINARY_NAME"

# Copy dylib into Frameworks
FRAMEWORKS_DIR="$APP_PATH/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"
cp "$DYLIB" "$FRAMEWORKS_DIR/$DYLIB_NAME"
echo "[*] Copied $DYLIB_NAME to Frameworks/"

# Inject load command
LOAD_PATH="@executable_path/Frameworks/$DYLIB_NAME"

if command -v optool &>/dev/null; then
    echo "[*] Injecting with optool..."
    optool install -c load -p "$LOAD_PATH" -t "$BINARY"
elif command -v insert_dylib &>/dev/null; then
    echo "[*] Injecting with insert_dylib..."
    insert_dylib "$LOAD_PATH" "$BINARY" --inplace --all-yes
else
    echo "[!] Neither optool nor insert_dylib found."
    echo "[*] Install one of:"
    echo "    brew install optool"
    echo "    https://github.com/optool/optool"
    echo "    https://github.com/tyilo/insert_dylib"
    exit 1
fi

echo "[*] Injected load command: $LOAD_PATH"

# Re-sign
if command -v ldid &>/dev/null; then
    echo "[*] Signing with ldid (ad-hoc)..."
    ldid -S "$FRAMEWORKS_DIR/$DYLIB_NAME"
    ldid -S "$BINARY"

    # Sign any other frameworks/dylibs
    find "$FRAMEWORKS_DIR" -name "*.dylib" -o -name "*.framework" | while read -r f; do
        ldid -S "$f" 2>/dev/null || true
    done
elif command -v codesign &>/dev/null; then
    echo "[*] Signing with codesign (ad-hoc)..."
    codesign -f -s - "$FRAMEWORKS_DIR/$DYLIB_NAME"
    codesign -f -s - "$BINARY"
else
    echo "[!] No signing tool found (ldid or codesign). Skipping signing."
    echo "[!] The IPA will need to be signed before installation."
fi

# Repackage
echo "[*] Repacking IPA..."
(cd "$WORK_DIR" && zip -qr - Payload/) > "$OUTPUT_IPA"

echo "[+] Done: $OUTPUT_IPA"
echo ""
echo "Install with:"
echo "  - TrollStore (no cert needed, iOS 14-16.6.1)"
echo "  - AltStore / Sideloadly (needs Apple ID)"
echo "  - Signing service + mobile config"
