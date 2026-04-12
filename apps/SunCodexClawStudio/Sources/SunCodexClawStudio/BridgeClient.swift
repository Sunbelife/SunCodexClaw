import AppKit
import Foundation

enum BridgeCommandError: LocalizedError {
    case runtimeNotFound
    case processFailed(message: String)

    var errorDescription: String? {
        switch self {
        case .runtimeNotFound:
            return "Studio 运行时还没有准备好。"
        case .processFailed(let message):
            return message
        }
    }
}

enum BotControlAction: String {
    case start
    case stop
    case restart
}

struct BridgeClient {
    func loadSummary(runtime: StudioRuntime) async throws -> SummaryResponse {
        try await run(command: "summary", account: nil, payload: Optional<SavePayload>.none, runtime: runtime, decode: SummaryResponse.self)
    }

    func loadEnvironmentHealth(runtime: StudioRuntime, account: String? = nil) async throws -> EnvironmentHealth {
        try await run(command: "health", account: account, payload: Optional<SavePayload>.none, runtime: runtime, decode: EnvironmentHealth.self)
    }

    func loadDetail(account: String, runtime: StudioRuntime) async throws -> BotDetail {
        try await run(command: "get", account: account, payload: Optional<SavePayload>.none, runtime: runtime, decode: BotDetail.self)
    }

    func save(account: String, editor: BotEditor, runtime: StudioRuntime) async throws -> SaveEnvelope {
        try await run(command: "save", account: account, payload: SavePayload(profile: editor), runtime: runtime, decode: SaveEnvelope.self)
    }

    func control(_ action: BotControlAction, account: String, runtime: StudioRuntime) async throws -> ActionEnvelope {
        try await run(command: action.rawValue, account: account, payload: Optional<SavePayload>.none, runtime: runtime, decode: ActionEnvelope.self)
    }

    func probe(account: String, runtime: StudioRuntime) async throws -> ProbeResult {
        try await run(command: "probe", account: account, payload: Optional<SavePayload>.none, runtime: runtime, decode: ProbeResult.self)
    }

    func loadThreads(account: String, runtime: StudioRuntime) async throws -> ThreadListResponse {
        try await run(command: "threads", account: account, payload: Optional<SavePayload>.none, runtime: runtime, decode: ThreadListResponse.self)
    }

    func createThread(account: String, payload: ThreadCreatePayload, runtime: StudioRuntime) async throws -> ThreadActionEnvelope {
        try await run(command: "thread-create", account: account, payload: payload, runtime: runtime, decode: ThreadActionEnvelope.self)
    }

    func closeThread(account: String, threadId: String, runtime: StudioRuntime) async throws -> ThreadActionEnvelope {
        try await run(command: "thread-close", account: account, payload: ThreadClosePayload(threadId: threadId), runtime: runtime, decode: ThreadActionEnvelope.self)
    }

    func sendThreadMessage(account: String, threadId: String, text: String, runtime: StudioRuntime) async throws -> ThreadSendEnvelope {
        try await run(
            command: "thread-send",
            account: account,
            payload: ThreadSendPayload(threadId: threadId, text: text),
            runtime: runtime,
            decode: ThreadSendEnvelope.self
        )
    }

    @MainActor
    func chooseDirectory(current: String) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "选择目录"
        panel.directoryURL = current.isEmpty ? nil : URL(fileURLWithPath: current)
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    private func run<Payload: Encodable & Sendable, Output: Decodable & Sendable>(
        command: String,
        account: String?,
        payload: Payload?,
        runtime: StudioRuntime,
        decode: Output.Type
    ) async throws -> Output {
        let bridgeURL = runtime.rootURL.appendingPathComponent("tools/feishu_desktop_bridge.js")
        guard FileManager.default.fileExists(atPath: bridgeURL.path) else {
            throw BridgeCommandError.runtimeNotFound
        }

        let payloadData: Data?
        if let payload {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            payloadData = try encoder.encode(payload)
        } else {
            payloadData = nil
        }

        return try await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.currentDirectoryURL = runtime.rootURL
            process.arguments = ["node", bridgeURL.path, command] + (account.map { [$0] } ?? [])
            var environment = ProcessInfo.processInfo.environment
            environment["SUNCODEXCLAW_LAUNCHCTL_PREFIX"] = runtime.launchctlPrefix
            process.environment = environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            if let payloadData {
                let stdin = Pipe()
                process.standardInput = stdin
                try process.run()
                stdin.fileHandleForWriting.write(payloadData)
                stdin.fileHandleForWriting.closeFile()
            } else {
                try process.run()
            }

            process.waitUntilExit()

            let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
            let stdoutText = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderrText = String(data: stderrData, encoding: .utf8) ?? ""

            guard process.terminationStatus == 0 else {
                let message = stderrText.isEmpty ? stdoutText : stderrText
                throw BridgeCommandError.processFailed(message: message.trimmingCharacters(in: .whitespacesAndNewlines))
            }

            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(Output.self, from: stdoutData)
        }.value
    }
}
