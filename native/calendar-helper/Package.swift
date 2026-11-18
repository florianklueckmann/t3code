// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CalendarHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "CalendarHelper"),
        .testTarget(name: "CalendarHelperTests", dependencies: ["CalendarHelper"]),
    ]
)
