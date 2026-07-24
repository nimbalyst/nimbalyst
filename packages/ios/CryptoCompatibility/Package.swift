// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CryptoCompatibility",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .testTarget(
            name: "CryptoCompatibilityTests",
            path: ".",
            exclude: ["generate-test-vectors.mjs", "test-vectors.json"]
        ),
    ]
)
