#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_code_bin() {
  if [[ -n "${CODE_BIN:-}" ]]; then
    printf '%s\n' "$CODE_BIN"
    return
  fi

  if command -v code >/dev/null 2>&1; then
    command -v code
    return
  fi

  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    printf '%s\n' "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    return
  fi

  if command -v code-insiders >/dev/null 2>&1; then
    command -v code-insiders
    return
  fi

  if [[ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" ]]; then
    printf '%s\n' "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
    return
  fi

  return 1
}

latest_vsix() {
  local latest=""
  local file

  shopt -s nullglob
  for file in "$ROOT_DIR"/extensions/vscode/build/continue-*.vsix; do
    if [[ -z "$latest" || "$file" -nt "$latest" ]]; then
      latest="$file"
    fi
  done
  shopt -u nullglob

  [[ -n "$latest" ]] || return 1
  printf '%s\n' "$latest"
}

CODE_CLI="$(find_code_bin)" || {
  echo "Could not find the VS Code CLI. Install the 'code' shell command or set CODE_BIN=/path/to/code." >&2
  exit 1
}

EXTENSION_ID="$(
  cd "$ROOT_DIR"
  node -e "const p=require('./extensions/vscode/package.json'); console.log(p.publisher + '.' + p.name)"
)"
EXTENSION_ID_LOWER="$(printf '%s' "$EXTENSION_ID" | tr '[:upper:]' '[:lower:]')"

echo "Using VS Code CLI: $CODE_CLI"
echo "Building GUI..."
npm --prefix "$ROOT_DIR/gui" run build

echo "Packaging VS Code extension..."
npm --prefix "$ROOT_DIR/extensions/vscode" run package

VSIX_PATH="$(latest_vsix)" || {
  echo "No VSIX was created in extensions/vscode/build." >&2
  exit 1
}

echo "Installing $VSIX_PATH..."
"$CODE_CLI" --install-extension "$VSIX_PATH" --force

echo "Verifying installed extension: $EXTENSION_ID"
found_extension="false"
while IFS= read -r installed_extension; do
  installed_extension_lower="$(printf '%s' "$installed_extension" | tr '[:upper:]' '[:lower:]')"
  if [[ "$installed_extension_lower" == "$EXTENSION_ID_LOWER" ]]; then
    found_extension="true"
    break
  fi
done < <("$CODE_CLI" --list-extensions)

if [[ "$found_extension" != "true" ]]; then
  echo "Installed VSIX, but $EXTENSION_ID was not found in VS Code's extension list." >&2
  exit 1
fi

echo "Installed $EXTENSION_ID from $VSIX_PATH"
