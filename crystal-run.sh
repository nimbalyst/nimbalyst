#!/bin/bash

# Parse command line arguments
USE_PRODUCTION_DB=false
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --use-production-db) USE_PRODUCTION_DB=true ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Use a different port for crystal-run.sh to avoid conflicts with production builds
DEV_PORT=5274

# Detect if we're in a git worktree and find the main repo root
# Sets WORKTREE_MODE=true and MAIN_REPO_ROOT if in a worktree
detect_worktree() {
  WORKTREE_MODE=false
  MAIN_REPO_ROOT=""

  # Check if .git is a file (worktree) rather than a directory (main repo)
  if [ -f ".git" ]; then
    WORKTREE_MODE=true
    # Parse the gitdir from the .git file to find the main repo
    local gitdir
    gitdir=$(cat .git | sed 's/gitdir: //')
    # The gitdir points to .git/worktrees/<name>, so go up 3 levels to get main repo
    MAIN_REPO_ROOT=$(cd "$gitdir/../../.." && pwd)
    echo "Worktree detected. Main repo: $MAIN_REPO_ROOT"
  fi
}

# Check if a package has local changes compared to main repo
# Returns 0 (true) if package has changes, 1 (false) if identical to main repo
package_has_worktree_changes() {
  local pkg_dir="$1"

  if [ "$WORKTREE_MODE" != "true" ]; then
    # Not in a worktree, consider it as having changes (needs normal rebuild check)
    return 0
  fi

  # Compare this package's source files with the main repo's version
  # Use git diff to compare the working tree with the main repo's HEAD
  local main_pkg_dir="$MAIN_REPO_ROOT/$pkg_dir"

  if [ ! -d "$main_pkg_dir" ]; then
    # Package doesn't exist in main repo, consider it as having changes
    return 0
  fi

  # Compare source directories
  if ! diff -rq "$pkg_dir/src" "$main_pkg_dir/src" >/dev/null 2>&1; then
    return 0
  fi

  # Compare key config files
  for config_file in vite.config.ts package.json tsconfig.json; do
    if [ -f "$pkg_dir/$config_file" ] || [ -f "$main_pkg_dir/$config_file" ]; then
      if ! diff -q "$pkg_dir/$config_file" "$main_pkg_dir/$config_file" >/dev/null 2>&1; then
        return 0
      fi
    fi
  done

  # No changes detected
  return 1
}

# Check if main repo has a built package we can copy
# Returns 0 (true) if main repo dist exists, 1 (false) otherwise
main_repo_has_dist() {
  local pkg_dir="$1"

  if [ "$WORKTREE_MODE" != "true" ]; then
    return 1
  fi

  local main_dist="$MAIN_REPO_ROOT/$pkg_dir/dist"
  [ -d "$main_dist" ] && [ "$(ls -A "$main_dist" 2>/dev/null)" ]
}

# Copy dist folder from main repo to worktree
copy_dist_from_main_repo() {
  local pkg_dir="$1"
  local main_dist="$MAIN_REPO_ROOT/$pkg_dir/dist"
  local local_dist="$pkg_dir/dist"

  echo "  Copying dist from main repo for $pkg_dir..."
  rm -rf "$local_dist"
  cp -R "$main_dist" "$local_dist"
}

# Compute a hash of all source files that affect the build
# This is worktree-safe because it's based on content, not timestamps
compute_source_hash() {
  local pkg_dir="$1"
  # Hash all source files + config files that affect the build
  # Using git ls-files to only include tracked files, sorted for consistency
  (
    cd "$pkg_dir"
    # Get content hash of all relevant files
    find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.css" -o -name "*.js" \) -print0 2>/dev/null | \
      sort -z | \
      xargs -0 cat 2>/dev/null | \
      shasum -a 256 | \
      cut -d' ' -f1
    # Also include config files in the hash
    cat vite.config.ts package.json 2>/dev/null | shasum -a 256 | cut -d' ' -f1
  ) | shasum -a 256 | cut -d' ' -f1
}

# Check if a package needs rebuilding based on content hash
# Returns 0 (true) if rebuild needed, 1 (false) if up-to-date
needs_rebuild() {
  local pkg_dir="$1"
  local hash_file="$pkg_dir/dist/.build-hash"

  # If dist or hash file doesn't exist, definitely need to build
  if [ ! -f "$hash_file" ]; then
    return 0
  fi

  local current_hash
  current_hash=$(compute_source_hash "$pkg_dir")
  local stored_hash
  stored_hash=$(cat "$hash_file" 2>/dev/null)

  if [ "$current_hash" != "$stored_hash" ]; then
    return 0
  fi

  # No rebuild needed
  return 1
}

# Save the current source hash after a successful build
save_build_hash() {
  local pkg_dir="$1"
  local hash_file="$pkg_dir/dist/.build-hash"
  compute_source_hash "$pkg_dir" > "$hash_file"
}

# Kill all dev processes (from any crystal-run.sh invocation), but NOT packaged apps from DMG
echo "Killing any existing dev processes from crystal-run.sh..."

killed_any=false

# Kill all Electron processes that are dev builds, not packaged apps
# Dev builds will have RUN_ONE_DEV_MODE in their environment or run from a git repo
for pid in $(pgrep -i electron 2>/dev/null); do
  # Get the executable path to check if it's a packaged app
  exe_path=$(ps -p "$pid" -o comm= 2>/dev/null)

  # Skip if it's from /Applications or /Volumes (packaged apps)
  if [[ "$exe_path" =~ ^/Applications ]] || [[ "$exe_path" =~ ^/Volumes ]]; then
    continue
  fi

  # Get the full command line to check for dev indicators
  cmd_line=$(ps -p "$pid" -o command= 2>/dev/null)

  # Check if this is a dev process by looking for:
  # 1. packages/electron in the path (dev build location)
  # 2. RUN_ONE_DEV_MODE in environment
  # 3. Running from a git repository
  if [[ "$cmd_line" =~ packages/electron ]] || [[ "$cmd_line" =~ RUN_ONE_DEV_MODE ]]; then
    echo "  Killing Electron dev process $pid"
    kill -9 "$pid" 2>/dev/null || true
    killed_any=true
    continue
  fi

  # Also check working directory - dev processes run from git repos
  if command -v lsof >/dev/null 2>&1; then
    proc_cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
    # If cwd contains 'git' or 'nimnim' (repo name), it's likely a dev process
    if [[ "$proc_cwd" =~ /git/ ]] || [[ "$proc_cwd" =~ nimnim ]]; then
      echo "  Killing Electron dev process $pid (cwd: $proc_cwd)"
      kill -9 "$pid" 2>/dev/null || true
      killed_any=true
    fi
  fi
done

# Kill all Vite dev servers (these are always dev, never packaged)
for pid in $(pgrep -f "vite.*--port" 2>/dev/null); do
  echo "  Killing Vite dev server $pid"
  kill -9 "$pid" 2>/dev/null || true
  killed_any=true
done

# Kill any node processes that are running Vite from packages/electron
for pid in $(pgrep -f "node.*packages/electron" 2>/dev/null); do
  echo "  Killing node process $pid (packages/electron)"
  kill -9 "$pid" 2>/dev/null || true
  killed_any=true
done

# Also kill by checking the specific port used by crystal-run.sh
if lsof -ti:$DEV_PORT > /dev/null 2>&1; then
  for pid in $(lsof -ti:$DEV_PORT 2>/dev/null); do
    # Get the executable path
    exe_path=$(ps -p "$pid" -o comm= 2>/dev/null)

    # Only kill if it's NOT from /Applications or /Volumes
    if [[ ! "$exe_path" =~ ^/Applications ]] && [[ ! "$exe_path" =~ ^/Volumes ]]; then
      echo "  Killing process $pid on port $DEV_PORT"
      kill -9 "$pid" 2>/dev/null || true
      killed_any=true
    fi
  done
fi

if [ "$killed_any" = true ]; then
  echo "Killed dev processes"
  # Wait a moment for processes to fully terminate
  sleep 2
else
  echo "No dev processes found to kill"
fi

# Detect worktree mode
detect_worktree

# Install dependencies if node_modules doesn't exist
needs_npm_install=false
if [ ! -d "node_modules" ]; then
  needs_npm_install=true
fi

# Determine what needs to be built
# In worktree mode, we can skip building if:
#   1. Package has no changes compared to main repo, AND
#   2. Main repo has the dist folder built (we'll copy it)
build_runtime=false
build_extension_sdk=false
build_extensions=false
build_runtime_reason=""
build_extension_sdk_reason=""
build_extensions_reason=""
copy_runtime_from_main=false
copy_extension_sdk_from_main=false
copy_extensions_from_main=false

# Check runtime
if [ "$WORKTREE_MODE" = "true" ]; then
  if package_has_worktree_changes "packages/runtime"; then
    # Has local changes, need to check if rebuild required
    if needs_rebuild "packages/runtime"; then
      build_runtime=true
      build_runtime_reason=" (local changes)"
    fi
  elif main_repo_has_dist "packages/runtime"; then
    # No local changes and main repo has dist - copy it
    if [ ! -d "packages/runtime/dist" ]; then
      copy_runtime_from_main=true
    fi
  else
    # No local changes but main repo doesn't have dist - need to build
    if needs_rebuild "packages/runtime"; then
      build_runtime=true
    fi
  fi
else
  # Not in worktree, use standard rebuild check
  if needs_rebuild "packages/runtime"; then
    build_runtime=true
  fi
fi

# Check extension-sdk
if [ "$WORKTREE_MODE" = "true" ]; then
  if package_has_worktree_changes "packages/extension-sdk"; then
    # Has local changes, need to check if rebuild required
    if needs_rebuild "packages/extension-sdk"; then
      build_extension_sdk=true
      build_extension_sdk_reason=" (local changes)"
    fi
  elif main_repo_has_dist "packages/extension-sdk"; then
    # No local changes and main repo has dist - copy it
    if [ ! -d "packages/extension-sdk/dist" ]; then
      copy_extension_sdk_from_main=true
    fi
  else
    # No local changes but main repo doesn't have dist - need to build
    if needs_rebuild "packages/extension-sdk"; then
      build_extension_sdk=true
    fi
  fi
else
  # Not in worktree, use standard rebuild check
  if needs_rebuild "packages/extension-sdk"; then
    build_extension_sdk=true
  fi
fi

# Check extensions - iterate through all extension directories
EXTENSION_DIRS=$(find packages/extensions -maxdepth 1 -type d -not -name extensions | sort)
for ext_dir in $EXTENSION_DIRS; do
  # Skip if no package.json or no build script
  if [ ! -f "$ext_dir/package.json" ]; then
    continue
  fi
  if ! grep -q '"build"' "$ext_dir/package.json" 2>/dev/null; then
    continue
  fi

  if [ "$WORKTREE_MODE" = "true" ]; then
    if package_has_worktree_changes "$ext_dir"; then
      if needs_rebuild "$ext_dir"; then
        build_extensions=true
        build_extensions_reason=" (local changes in $(basename $ext_dir))"
        break
      fi
    elif main_repo_has_dist "$ext_dir" && [ ! -d "$ext_dir/dist" ]; then
      # No local changes and main repo has dist - will copy
      copy_extensions_from_main=true
    elif ! main_repo_has_dist "$ext_dir"; then
      if needs_rebuild "$ext_dir"; then
        build_extensions=true
        break
      fi
    fi
  else
    if needs_rebuild "$ext_dir"; then
      build_extensions=true
      break
    fi
  fi
done

# Print build plan
echo ""
echo "Build plan:"
if [ "$copy_runtime_from_main" = true ]; then
  echo "  runtime: COPY from main repo (no local changes)"
elif [ "$build_runtime" = true ]; then
  echo "  runtime: BUILD$build_runtime_reason"
else
  echo "  runtime: skip (up-to-date)"
fi
if [ "$copy_extension_sdk_from_main" = true ]; then
  echo "  extension-sdk: COPY from main repo (no local changes)"
elif [ "$build_extension_sdk" = true ]; then
  echo "  extension-sdk: BUILD$build_extension_sdk_reason"
else
  echo "  extension-sdk: skip (up-to-date)"
fi
if [ "$copy_extensions_from_main" = true ]; then
  echo "  extensions: COPY from main repo (no local changes)"
elif [ "$build_extensions" = true ]; then
  echo "  extensions: BUILD$build_extensions_reason"
else
  echo "  extensions: skip (up-to-date)"
fi
echo ""

# Execute build plan
if [ "$needs_npm_install" = true ]; then
  echo "Installing dependencies..."
  npm install
fi

# Handle runtime
if [ "$copy_runtime_from_main" = true ]; then
  copy_dist_from_main_repo "packages/runtime"
elif [ "$build_runtime" = true ]; then
  echo "Building runtime package..."
  cd packages/runtime
  npm run build
  cd ../..
  save_build_hash "packages/runtime"
fi

# Handle extension-sdk
if [ "$copy_extension_sdk_from_main" = true ]; then
  copy_dist_from_main_repo "packages/extension-sdk"
elif [ "$build_extension_sdk" = true ]; then
  echo "Building extension-sdk package..."
  cd packages/extension-sdk
  npm run build
  cd ../..
  save_build_hash "packages/extension-sdk"
fi

# Handle extensions - build all extensions with a build script
if [ "$build_extensions" = true ]; then
  echo "Building extensions..."
  for ext_dir in $EXTENSION_DIRS; do
    # Skip if no package.json or no build script
    if [ ! -f "$ext_dir/package.json" ]; then
      continue
    fi
    if ! grep -q '"build"' "$ext_dir/package.json" 2>/dev/null; then
      continue
    fi

    ext_name=$(basename "$ext_dir")
    if needs_rebuild "$ext_dir"; then
      echo "  Building $ext_name..."
      (cd "$ext_dir" && npm run build)
      save_build_hash "$ext_dir"
    else
      echo "  $ext_name: skip (up-to-date)"
    fi
  done
elif [ "$copy_extensions_from_main" = true ]; then
  echo "Copying extensions from main repo..."
  for ext_dir in $EXTENSION_DIRS; do
    if [ ! -f "$ext_dir/package.json" ]; then
      continue
    fi
    if main_repo_has_dist "$ext_dir" && [ ! -d "$ext_dir/dist" ]; then
      copy_dist_from_main_repo "$ext_dir"
    fi
  done
fi

# Navigate to the electron package directory
cd packages/electron

# Derive a unique userData directory name when in worktree mode
# Without this, all worktree instances share Nimbalyst-Dev and cross-pollinate settings (theme, etc.)
if [ "$WORKTREE_MODE" = "true" ]; then
  WORKTREE_NAME=$(basename "$(pwd)")
  NIMBALYST_USER_DATA="$HOME/Library/Application Support/@nimbalyst/electron-wt-${WORKTREE_NAME}"
else
  NIMBALYST_USER_DATA=""
fi

# Run the dev app with custom port
if [ "$USE_PRODUCTION_DB" = true ]; then
  echo "Starting Nimbalyst on port $DEV_PORT with PRODUCTION database..."
  echo "WARNING: Changes will affect your real data!"
  VITE_PORT=$DEV_PORT npm run dev:loop
elif [ -n "$NIMBALYST_USER_DATA" ]; then
  echo "Starting Nimbalyst on port $DEV_PORT with worktree-isolated user data..."
  echo "  userData: $NIMBALYST_USER_DATA"
  echo "Use /restart in AI chat to restart the app."
  NIMBALYST_USER_DATA_DIR="$NIMBALYST_USER_DATA" VITE_PORT=$DEV_PORT npm run dev:loop
else
  echo "Starting Nimbalyst on port $DEV_PORT with isolated user data..."
  echo "Use /restart in AI chat to restart the app."
  VITE_PORT=$DEV_PORT RUN_ONE_DEV_MODE=true npm run dev:loop
fi

echo "Nimbalyst has been launched!"
