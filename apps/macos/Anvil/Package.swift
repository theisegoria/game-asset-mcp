// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Anvil",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(
            name: "Anvil",
            targets: ["Anvil"]
        ),
        .library(
            name: "AnvilKit",
            targets: ["AnvilKit"]
        )
    ],
    targets: [
        // Process boundary, transport, run registry and command catalog.
        // Deliberately free of SwiftUI so it can be tested without a UI host.
        .target(
            name: "AnvilKit",
            path: "Sources/AnvilKit"
        ),
        .executableTarget(
            name: "Anvil",
            dependencies: ["AnvilKit"],
            path: "Sources/Anvil"
        ),
        .testTarget(
            name: "AnvilKitTests",
            dependencies: ["AnvilKit"],
            path: "Tests/AnvilKitTests"
        )
    ],
    swiftLanguageModes: [.v6]
)
