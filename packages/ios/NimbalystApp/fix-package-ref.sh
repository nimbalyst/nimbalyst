#!/bin/bash
# Workaround for XcodeGen not adding the 'package' back-reference in
# XCSwiftPackageProductDependency for local Swift packages.
# See: https://github.com/yonaskolb/XcodeGen/issues/1549
#
# Run this after `xcodegen generate` to fix the "Missing package product" error.
# Usage: cd NimbalystApp && xcodegen generate && ./fix-package-ref.sh

PBXPROJ="NimbalystApp.xcodeproj/project.pbxproj"

# Find the XCLocalSwiftPackageReference ID for NimbalystNative
# Grab the definition line (with "= {") to get exactly one match
PKG_REF=$(grep 'XCLocalSwiftPackageReference "../NimbalystNative".*= {' "$PBXPROJ" | grep -oE '[A-F0-9]{24}' | head -1)

if [ -z "$PKG_REF" ]; then
    echo "Error: Could not find NimbalystNative package reference in $PBXPROJ"
    exit 1
fi

# Check if the fix is already applied (package = <ref> exists in the product dependency block)
if grep -A2 'XCSwiftPackageProductDependency' "$PBXPROJ" | grep -q "package = $PKG_REF"; then
    echo "Package reference already linked, no fix needed."
    exit 0
fi

# Insert package = <ref> after the isa line in XCSwiftPackageProductDependency
sed -i '' "/isa = XCSwiftPackageProductDependency;/a\\
\\			package = $PKG_REF /* XCLocalSwiftPackageReference \"..\/NimbalystNative\" */;
" "$PBXPROJ"

echo "Fixed: Added package = $PKG_REF to XCSwiftPackageProductDependency"
