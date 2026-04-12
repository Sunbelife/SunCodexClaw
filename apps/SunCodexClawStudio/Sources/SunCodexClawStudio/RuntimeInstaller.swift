import Foundation

struct StudioRuntime: Sendable, Equatable {
    let rootURL: URL
    let supportURL: URL
    let templateURL: URL
    let launchctlPrefix: String
    let bundleVersion: String
    let isFreshInstall: Bool
    let didRefreshRuntime: Bool
}

enum RuntimeInstallerError: LocalizedError {
    case missingTemplate
    case shellCommandFailed(message: String)

    var errorDescription: String? {
        switch self {
        case .missingTemplate:
            return "App 包内没有找到运行时模板，无法初始化 Studio。"
        case .shellCommandFailed(let message):
            return message
        }
    }
}

enum RuntimeInstaller {
    static let supportFolderName = "SunCodexClawStudio"
    static let runtimeFolderName = "runtime"
    static let versionMarkerName = ".studio-runtime-version"
    static let launchctlPrefix = "com.sunbelife.suncodexclaw.studio.feishu"

    static func prepare() throws -> StudioRuntime {
        let fileManager = FileManager.default
        guard let templateURL = Bundle.main.resourceURL?.appendingPathComponent("RuntimeTemplate", isDirectory: true),
              fileManager.fileExists(atPath: templateURL.path) else {
            throw RuntimeInstallerError.missingTemplate
        }

        let applicationSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let supportURL = applicationSupport.appendingPathComponent(supportFolderName, isDirectory: true)
        let runtimeURL = supportURL.appendingPathComponent(runtimeFolderName, isDirectory: true)
        let bundleVersion = resolvedBundleVersion()

        try fileManager.createDirectory(at: supportURL, withIntermediateDirectories: true, attributes: nil)

        let runtimeExists = fileManager.fileExists(atPath: runtimeURL.path)
        let installedVersion = try? String(contentsOf: runtimeURL.appendingPathComponent(versionMarkerName), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldRefresh = !runtimeExists || installedVersion != bundleVersion || !bridgeExists(at: runtimeURL)

        if shouldRefresh {
            try syncTemplate(from: templateURL, into: runtimeURL)
            try bundleVersion.write(
                to: runtimeURL.appendingPathComponent(versionMarkerName),
                atomically: true,
                encoding: .utf8
            )
        } else {
            try ensureMutableScaffold(in: runtimeURL)
        }

        return StudioRuntime(
            rootURL: runtimeURL,
            supportURL: supportURL,
            templateURL: templateURL,
            launchctlPrefix: launchctlPrefix,
            bundleVersion: bundleVersion,
            isFreshInstall: !runtimeExists,
            didRefreshRuntime: shouldRefresh
        )
    }

    private static func bridgeExists(at runtimeURL: URL) -> Bool {
        FileManager.default.fileExists(
            atPath: runtimeURL
                .appendingPathComponent("tools/feishu_desktop_bridge.js")
                .path
        )
    }

    private static func resolvedBundleVersion() -> String {
        let short = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        switch (short, build) {
        case let (.some(short), .some(build)) where !short.isEmpty && !build.isEmpty:
            return "\(short)-\(build)"
        case let (.some(short), _) where !short.isEmpty:
            return short
        case let (_, .some(build)) where !build.isEmpty:
            return build
        default:
            return "dev"
        }
    }

    private static func syncTemplate(from templateURL: URL, into runtimeURL: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true, attributes: nil)

        for component in [
            "tools",
            "node_modules",
            "package.json",
            "package-lock.json",
            "config/feishu/default.json",
            "config/feishu/default.example.json",
            "config/secrets/local.example.yaml",
        ] {
            let sourceURL = templateURL.appendingPathComponent(component)
            guard fileManager.fileExists(atPath: sourceURL.path) else { continue }
            let destinationURL = runtimeURL.appendingPathComponent(component)
            try syncItem(from: sourceURL, to: destinationURL)
        }

        try ensureMutableScaffold(in: runtimeURL)
    }

    private static func syncItem(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
        try dittoCopy(from: sourceURL, to: destinationURL)
    }

    private static func ensureMutableScaffold(in runtimeURL: URL) throws {
        let fileManager = FileManager.default

        let feishuConfigURL = runtimeURL.appendingPathComponent("config/feishu", isDirectory: true)
        let secretConfigURL = runtimeURL.appendingPathComponent("config/secrets", isDirectory: true)
        let logsURL = runtimeURL.appendingPathComponent(".runtime/feishu/logs", isDirectory: true)
        let pidsURL = runtimeURL.appendingPathComponent(".runtime/feishu/pids", isDirectory: true)

        try fileManager.createDirectory(at: feishuConfigURL, withIntermediateDirectories: true, attributes: nil)
        try fileManager.createDirectory(at: secretConfigURL, withIntermediateDirectories: true, attributes: nil)
        try fileManager.createDirectory(at: logsURL, withIntermediateDirectories: true, attributes: nil)
        try fileManager.createDirectory(at: pidsURL, withIntermediateDirectories: true, attributes: nil)

        let defaultURL = feishuConfigURL.appendingPathComponent("default.json")
        let defaultExampleURL = feishuConfigURL.appendingPathComponent("default.example.json")
        if !fileManager.fileExists(atPath: defaultURL.path), fileManager.fileExists(atPath: defaultExampleURL.path) {
            try fileManager.copyItem(at: defaultExampleURL, to: defaultURL)
        }

        let localSecretsURL = secretConfigURL.appendingPathComponent("local.yaml")
        if !fileManager.fileExists(atPath: localSecretsURL.path) {
            try "config:\n  feishu: {}\n".write(to: localSecretsURL, atomically: true, encoding: .utf8)
        }
    }

    private static func dittoCopy(from sourceURL: URL, to destinationURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = [sourceURL.path, destinationURL.path]

        let stderr = Pipe()
        process.standardError = stderr

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "ditto failed"
            throw RuntimeInstallerError.shellCommandFailed(message: message)
        }
    }
}
