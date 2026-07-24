#!/bin/bash

# Script to set up Cloudflare R2 bucket for alpha releases
# This script guides you through the R2 setup process

set -e

echo "=== Nimbalyst Alpha Release Channel - R2 Setup ==="
echo ""
echo "This script will help you set up a Cloudflare R2 bucket for alpha releases."
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found."
    echo ""
    echo "Installing wrangler globally..."
    npm install -g wrangler
    echo "✅ Wrangler installed"
    echo ""
fi

# Login to Cloudflare
echo "Step 1: Login to Cloudflare"
echo "This will open a browser window for authentication..."
echo ""
wrangler login

echo ""
echo "✅ Logged in to Cloudflare"
echo ""

# Generate a random bucket suffix for obscurity
RANDOM_SUFFIX=$(openssl rand -hex 4)
BUCKET_NAME="nimbalyst-alpha-updates-${RANDOM_SUFFIX}"

echo "Step 2: Create R2 bucket"
echo "Bucket name: ${BUCKET_NAME}"
echo ""

# Create the bucket
wrangler r2 bucket create "${BUCKET_NAME}"

echo ""
echo "✅ Bucket created: ${BUCKET_NAME}"
echo ""

# Get bucket info
echo "Step 3: Getting bucket information..."
echo ""

# The public URL format is: https://pub-{bucket-id}.r2.dev/
# We need to enable public access through the dashboard
echo "⚠️  IMPORTANT: You need to enable public access via the Cloudflare Dashboard"
echo ""
echo "Go to: https://dash.cloudflare.com/"
echo "1. Navigate to R2 Object Storage"
echo "2. Click on bucket: ${BUCKET_NAME}"
echo "3. Go to Settings tab"
echo "4. Under 'Public access', click 'Allow Access'"
echo "5. Copy the public R2.dev URL (format: https://pub-XXXXXXXX.r2.dev/)"
echo ""
read -p "Press Enter after you've enabled public access and copied the URL..."

echo ""
read -p "Paste the public R2.dev URL here: " R2_PUBLIC_URL

# Validate URL format
if [[ ! "$R2_PUBLIC_URL" =~ ^https://pub-[a-zA-Z0-9]+\.r2\.dev/?$ ]]; then
    echo "❌ Invalid URL format. Expected: https://pub-XXXXXXXX.r2.dev/"
    exit 1
fi

# Ensure URL ends with /
if [[ ! "$R2_PUBLIC_URL" =~ /$ ]]; then
    R2_PUBLIC_URL="${R2_PUBLIC_URL}/"
fi

echo ""
echo "✅ Public URL validated: ${R2_PUBLIC_URL}"
echo ""

echo "Step 4: Create API Token for GitHub Actions"
echo ""
echo "⚠️  You need to create an API token via the Cloudflare Dashboard"
echo ""
echo "Go to: https://dash.cloudflare.com/profile/api-tokens"
echo "1. Click 'Create Token'"
echo "2. Use 'Create Custom Token'"
echo "3. Token name: nimbalyst-github-actions"
echo "4. Permissions: Account > R2 Storage > Edit"
echo "5. Account Resources: Include > Specific account > [Your Account]"
echo "6. Click 'Continue to summary' then 'Create Token'"
echo "7. Copy the Access Key ID and Secret Access Key"
echo ""
read -p "Press Enter after you've created the token..."

echo ""
read -p "Paste the Access Key ID: " R2_ACCESS_KEY_ID
read -sp "Paste the Secret Access Key: " R2_SECRET_ACCESS_KEY
echo ""

# Get Account ID
echo ""
echo "Getting your Cloudflare Account ID..."
ACCOUNT_ID=$(wrangler whoami | grep "Account ID" | awk '{print $NF}')

if [ -z "$ACCOUNT_ID" ]; then
    echo "❌ Could not retrieve Account ID automatically"
    echo ""
    echo "Go to: https://dash.cloudflare.com/ and copy your Account ID from the R2 Overview page"
    read -p "Paste your Account ID: " ACCOUNT_ID
fi

echo ""
echo "✅ Account ID: ${ACCOUNT_ID}"
echo ""

# Summary
echo "=== Setup Complete ==="
echo ""
echo "📋 Configuration Summary:"
echo ""
echo "Bucket Name: ${BUCKET_NAME}"
echo "Public URL: ${R2_PUBLIC_URL}"
echo "Account ID: ${ACCOUNT_ID}"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Update autoUpdater.ts:"
echo "   Replace: https://pub-REPLACE-ME.r2.dev/"
echo "   With: ${R2_PUBLIC_URL}"
echo "   File: packages/electron/src/main/services/autoUpdater.ts:37"
echo ""
echo "2. Add GitHub Secrets (Settings > Secrets and variables > Actions):"
echo "   - R2_ACCESS_KEY_ID = ${R2_ACCESS_KEY_ID}"
echo "   - R2_SECRET_ACCESS_KEY = (the secret you entered)"
echo "   - CLOUDFLARE_ACCOUNT_ID = ${ACCOUNT_ID}"
echo ""
echo "3. Update .github/workflows/electron-build.yml"
echo "   Add R2 upload step after build"
echo ""
echo "Would you like me to update autoUpdater.ts automatically? (y/n)"
read -p "> " UPDATE_AUTO

if [[ "$UPDATE_AUTO" == "y" || "$UPDATE_AUTO" == "Y" ]]; then
    # Update the autoUpdater.ts file
    sed -i.bak "s|https://pub-REPLACE-ME.r2.dev/|${R2_PUBLIC_URL}|g" packages/electron/src/main/services/autoUpdater.ts
    echo "✅ Updated autoUpdater.ts"
    echo "   Backup saved as autoUpdater.ts.bak"
else
    echo "⚠️  Remember to manually update autoUpdater.ts"
fi

echo ""
echo "✅ R2 setup complete!"
echo ""
echo "Save this information in a secure location (password manager):"
echo "Bucket: ${BUCKET_NAME}"
echo "URL: ${R2_PUBLIC_URL}"
echo "Access Key ID: ${R2_ACCESS_KEY_ID}"
echo "Secret Access Key: (you entered this)"
echo "Account ID: ${ACCOUNT_ID}"
