// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SunCodexClawStudio",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "SunCodexClawStudio",
            targets: ["SunCodexClawStudio"]
        )
    ],
    targets: [
        .executableTarget(
            name: "SunCodexClawStudio",
            path: "Sources/SunCodexClawStudio"
        )
    ]
)
