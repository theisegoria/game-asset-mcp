// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "GameDevelopmentStudio",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(
            name: "GameDevelopmentStudio",
            targets: ["GameDevelopmentStudio"]
        )
    ],
    targets: [
        .executableTarget(
            name: "GameDevelopmentStudio",
            path: "Sources/GameDevelopmentStudio"
        ),
        .testTarget(
            name: "GameDevelopmentStudioTests",
            dependencies: ["GameDevelopmentStudio"],
            path: "Tests/GameDevelopmentStudioTests"
        )
    ],
    swiftLanguageModes: [.v6]
)
