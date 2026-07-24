# Dev Container for Nimbalyst E2E Testing
# Based on Node.js 20 with Electron and Playwright dependencies

FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Avoid prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install Xvfb and dependencies required for Electron
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Xvfb for headless display
    xvfb \
    # Electron/Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libgtk-3-0 \
    # Additional utilities
    dbus \
    x11-utils \
    # Clean up
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set up display environment variable
ENV DISPLAY=:99

# Create a script to start Xvfb
RUN echo '#!/bin/bash\nXvfb :99 -screen 0 1920x1080x24 &\nsleep 1\nexec "$@"' > /usr/local/bin/with-xvfb \
    && chmod +x /usr/local/bin/with-xvfb

# Upgrade npm to version 10.x (matches CI workflow)
RUN npm install -g npm@10

# Set working directory
WORKDIR /workspaces/nimbalyst
