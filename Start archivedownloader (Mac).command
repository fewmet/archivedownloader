#!/bin/bash
# Double-click to start archivedownloader (also works on Linux: ./"Start archivedownloader (Mac).command")
cd "$(dirname "$0")" || exit 1

NODE=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 18 ] 2>/dev/null; then NODE="node"; fi
fi

if [ -z "$NODE" ] && [ -x runtime/bin/node ]; then NODE="runtime/bin/node"; fi

if [ -z "$NODE" ]; then
  echo ""
  echo "  First run: downloading Node.js into this folder - about 40 MB, only once."
  echo "  Nothing gets installed on your computer."
  echo ""
  version="v22.23.3"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) file="node-$version-darwin-arm64.tar.gz" ;;
    Darwin-*)     file="node-$version-darwin-x64.tar.gz" ;;
    Linux-x86_64) file="node-$version-linux-x64.tar.gz" ;;
    Linux-aarch64) file="node-$version-linux-arm64.tar.gz" ;;
    *) echo "  This computer type isn't supported. Install Node.js from https://nodejs.org"; read -r -p "  Press Enter to close."; exit 1 ;;
  esac
  mkdir -p runtime
  if ! curl -fL --progress-bar "https://nodejs.org/dist/$version/$file" | tar -xz -C runtime --strip-components=1; then
    echo ""
    echo "  Couldn't download Node.js. Check your internet connection and try again,"
    echo "  or install Node.js yourself from https://nodejs.org"
    read -r -p "  Press Enter to close."
    exit 1
  fi
  NODE="runtime/bin/node"
fi

OPEN_BROWSER=1 "$NODE" server.js
echo ""
echo "  archivedownloader stopped."
read -r -p "  Press Enter to close."
