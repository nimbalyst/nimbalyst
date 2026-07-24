---
name: e2e-devcontainer
description: Run E2E tests in a dev container (isolated environment)
---
Run E2E tests in a dev container for isolation. This command manages the full container lifecycle automatically.

**Important:** This is designed for worktree-based workflows where multiple containers may run simultaneously. Each worktree gets its own named container for isolation.

## Your Responsibilities

When this command is invoked, you MUST:

1. **Ensure Docker is running** - Start Docker Desktop if needed
2. **Build image if needed** - Check if `nimbalyst-devcontainer:latest` exists, build if not
3. **Create unique container** - Start a container with a unique name based on worktree + timestamp
4. **Wait for initialization** - Run post-create setup if this is a fresh container
5. **Execute tests** - Run the requested tests inside the container
6. **Always cleanup** - Stop and remove the container when tests complete (success or failure)

**CRITICAL:** Always remove the container at the end, even if tests fail. This ensures no resource leaks.

## Container Naming

Use a unique container name to prevent conflicts:
```bash
# Generate unique container name with timestamp
WORKTREE_NAME=$(basename "$(pwd)")
TIMESTAMP=$(date +%s)
CONTAINER_NAME="nimbalyst-e2e-${WORKTREE_NAME}-${TIMESTAMP}"
```

This ensures:
- Multiple test runs in the same worktree don't conflict
- Different worktrees can run tests simultaneously
- Old containers from crashed sessions don't interfere

## Complete Workflow

```bash
# 1. Ensure Docker is running
if ! docker info > /dev/null 2>&1; then
  # Kill any stuck Docker processes before starting fresh
  pkill -9 -f "com.docker" 2>/dev/null
  pkill -9 -f "Docker Desktop" 2>/dev/null
  sleep 3
  echo "Starting Docker Desktop..."
  open -a Docker
  # Wait for Docker to be ready (max 120 seconds — cold starts can take 1-2 min)
  for i in {1..120}; do
    if docker info > /dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# 2. Check if image exists, build if needed
if ! docker images | grep -q nimbalyst-devcontainer; then
  echo "Building dev container image..."
  docker build -t nimbalyst-devcontainer:latest -f .devcontainer/Dockerfile .
fi

# 3. Create unique container
# CRITICAL: Always use create-container.sh — it isolates ALL node_modules dirs
# with anonymous Docker volumes so npm ci doesn't corrupt host darwin binaries.
CONTAINER_NAME="nimbalyst-e2e-$(basename "$(pwd)")-$(date +%s)"
CONTAINER_NAME=$(bash .devcontainer/create-container.sh "${CONTAINER_NAME}")

# 4. Run setup (always run on fresh container)
echo "Running container setup..."
docker exec -w /workspaces/nimbalyst "${CONTAINER_NAME}" bash .devcontainer/post-create.sh

# 5. Run tests
echo "Running tests..."
docker exec -w /workspaces/nimbalyst "${CONTAINER_NAME}" \
  bash .devcontainer/run-e2e-tests.sh [test-pattern]

# Save exit code
TEST_EXIT=$?

# 6. ALWAYS cleanup (even if tests failed)
echo "Cleaning up container..."
docker rm -f "${CONTAINER_NAME}"

# Exit with test status
exit $TEST_EXIT
```

## Test Patterns

When running tests, you can specify:
- No args: Run all E2E tests
- Specific file: `e2e/core/app-startup.spec.ts`
- Directory: `e2e/monaco/`
- Multiple files: `e2e/core/app-startup.spec.ts e2e/ai/claude-code-basic.spec.ts`

## Setup Process

Every fresh container runs the full setup (`.devcontainer/post-create.sh`):
1. `npm ci` - Install dependencies
2. Build runtime, extension-sdk, extensions
3. Build Electron app
4. Install Playwright browsers

This takes several minutes but ensures a clean, reproducible environment for every test run.

## What the Test Script Does

The `.devcontainer/run-e2e-tests.sh` script inside the container:

1. Starts Xvfb (X virtual framebuffer) if needed
2. Launches the Vite dev server with `--noSandbox` flag (required for containers)
3. Waits for the dev server to be ready on localhost:5273
4. Runs Playwright tests with `--workers=1` (required due to PGLite corruption)
5. Cleans up dev server process on completion

## Test Output

Test artifacts are written to the mounted workspace volume:
- `e2e_test_output/videos/` - WebM video recordings of every test run (always-on by default)
- `e2e_test_output/` - screenshots, traces by test name
- `e2e_test_output/playwright-report/` - HTML report

These directories are gitignored and accessible from both host and container.

### Showing Results to the User

After tests complete, convert video recordings to GIF and display them inline using `mcp__nimbalyst__display_to_user`:

```bash
# Convert WebM to GIF using ffmpeg
ffmpeg -y -i e2e_test_output/videos/<hash>.webm \
  -vf "fps=10,scale=1080:-1:flags=lanczos" -loop 0 \
  e2e_test_output/videos/test-results.gif
```

Then display with `display_to_user` using the GIF path. This lets the user see the test run directly in the conversation without opening external files.

## Cleanup of Stale Containers

If previous runs crashed or were interrupted, you may need to clean up:

```bash
# List all E2E containers (running and stopped)
docker ps -a --filter "name=nimbalyst-e2e-"

# Remove all E2E containers from this worktree
WORKTREE_NAME=$(basename "$(pwd)")
docker rm -f $(docker ps -aq --filter "name=nimbalyst-e2e-${WORKTREE_NAME}-")

# Remove ALL E2E containers (all worktrees)
docker rm -f $(docker ps -aq --filter "name=nimbalyst-e2e-")
```

## Workflow Summary

1. User invokes `/e2e-devcontainer [test-pattern]`
2. You ensure Docker is running
3. You check if dev container image exists, build if needed
4. You create a fresh container with unique timestamped name
5. You run full setup inside container
6. You execute tests via `docker exec`
7. You capture test exit code
8. You ALWAYS remove the container (success or failure)
9. You exit with the test exit code

## Troubleshooting

**Container won't start:**
- Check Docker is running: `docker info`
- Check if name conflicts: `docker ps -a --filter "name=${CONTAINER_NAME}"`

**Setup failures:**
- Check logs: `docker logs "${CONTAINER_NAME}"`
- Try rebuilding: `docker rm -f "${CONTAINER_NAME}" && docker rmi nimbalyst-devcontainer:latest`

**Port conflicts:**
- Each container runs tests sequentially, so port 5273 is only used internally
- Multiple containers can run simultaneously without port conflicts

**Tests fail inside container:**
- Check container logs: `docker exec "${CONTAINER_NAME}" cat /tmp/vite-e2e.log`
- Verify Xvfb: `docker exec "${CONTAINER_NAME}" pgrep Xvfb`
- Check disk space: `docker exec "${CONTAINER_NAME}" df -h`
