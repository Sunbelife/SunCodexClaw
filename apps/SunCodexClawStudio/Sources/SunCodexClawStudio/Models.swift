import Foundation

struct SummaryResponse: Decodable, Sendable {
    let repo: String
    let secretFile: String
    let accounts: [BotSummary]
}

struct BotSummary: Decodable, Identifiable, Equatable, Sendable {
    let account: String
    let displayName: String
    let status: BotRuntimeStatus
    let activity: ActivitySummary
    let boot: BootSummary
    let checklistDone: Int
    let checklistTotal: Int

    var id: String { account }
}

struct BotRuntimeStatus: Decodable, Equatable, Sendable {
    let account: String
    let state: String
    let pid: Int?
    let manager: String
    let lastExit: String
    let stalePid: String
    let logPath: String
    let raw: String
}

struct ActivitySummary: Decodable, Equatable, Sendable {
    let state: String
    let label: String
    let detail: String
}

struct BootSummary: Decodable, Equatable, Sendable {
    let codexCwd: String
    let codexModel: String
    let progressMode: String
    let mentionAliases: String
}

struct BotDetail: Decodable, Equatable, Sendable {
    let account: String
    let displayName: String
    let status: BotRuntimeStatus
    let activity: BotActivity
    let paths: BotPaths
    let editor: BotEditor
    let checklist: [ChecklistItem]
}

struct BotActivity: Decodable, Equatable, Sendable {
    let boot: [String: String]
    let activeEvent: BotEvent?
    let lastEvent: BotEvent?
    let lastReply: BotReply?
    let lastError: BotError?
    let logExcerpt: [String]
    let logPath: String
    let logUpdatedAt: String
    let summary: ActivitySummary
}

struct BotEvent: Decodable, Equatable, Sendable {
    let chatId: String
    let chatType: String
    let messageId: String
    let messageType: String
    let senderType: String?
    let chatScope: String?
    let chatScopeKind: String?
    let skipReason: String?
    let state: String
    let codexThreadId: String?
    let localThread: String?
    let replyMode: String?
}

struct BotReply: Decodable, Equatable, Sendable {
    let state: String
    let mode: String
    let localThread: String
    let codexThreadId: String
}

struct BotError: Decodable, Equatable, Sendable {
    let code: String
    let summary: String
    let raw: [String]
}

struct BotPaths: Decodable, Equatable, Sendable {
    let repo: String
    let jsonConfig: String
    let secretFile: String
    let logFile: String
}

struct ChecklistItem: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let done: Bool
    let hint: String
}

struct BotEditor: Codable, Equatable, Sendable {
    var appId: String
    var appSecret: String
    var encryptKey: String
    var verificationToken: String
    var botOpenId: String
    var botName: String
    var domain: String
    var replyMode: String
    var replyPrefix: String
    var ignoreSelfMessages: Bool
    var autoReply: Bool
    var requireMention: Bool
    var requireMentionGroupOnly: Bool
    var progress: ProgressEditor
    var codex: CodexEditor
    var speech: SpeechEditor

    static let empty = BotEditor(
        appId: "",
        appSecret: "",
        encryptKey: "",
        verificationToken: "",
        botOpenId: "",
        botName: "",
        domain: "feishu",
        replyMode: "codex",
        replyPrefix: "",
        ignoreSelfMessages: true,
        autoReply: true,
        requireMention: true,
        requireMentionGroupOnly: true,
        progress: .empty,
        codex: .empty,
        speech: .empty
    )
}

struct ProgressEditor: Codable, Equatable, Sendable {
    var enabled: Bool
    var message: String
    var mode: String
    var doc: ProgressDocEditor

    static let empty = ProgressEditor(
        enabled: true,
        message: "已接收，正在执行。",
        mode: "doc",
        doc: .empty
    )
}

struct ProgressDocEditor: Codable, Equatable, Sendable {
    var titlePrefix: String
    var shareToChat: Bool
    var linkScope: String
    var includeUserMessage: Bool
    var writeFinalReply: Bool

    static let empty = ProgressDocEditor(
        titlePrefix: "",
        shareToChat: true,
        linkScope: "same_tenant",
        includeUserMessage: true,
        writeFinalReply: true
    )
}

struct CodexEditor: Codable, Equatable, Sendable {
    var bin: String
    var apiKey: String
    var model: String
    var reasoningEffort: String
    var profile: String
    var cwd: String
    var addDirs: [String]
    var historyTurns: Int
    var systemPrompt: String
    var sandbox: String
    var approvalPolicy: String

    static let empty = CodexEditor(
        bin: "codex",
        apiKey: "",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        profile: "",
        cwd: "",
        addDirs: [],
        historyTurns: 6,
        systemPrompt: "",
        sandbox: "danger-full-access",
        approvalPolicy: "never"
    )
}

struct SpeechEditor: Codable, Equatable, Sendable {
    var enabled: Bool
    var apiKey: String
    var model: String
    var language: String
    var baseUrl: String
    var ffmpegBin: String

    static let empty = SpeechEditor(
        enabled: true,
        apiKey: "",
        model: "gpt-4o-mini-transcribe",
        language: "",
        baseUrl: "https://api.openai.com/v1",
        ffmpegBin: ""
    )
}

struct ActionEnvelope: Decodable, Sendable {
    let ok: Bool
    let action: String?
    let account: String
    let output: String?
    let detail: BotDetail
}

struct SaveEnvelope: Decodable, Sendable {
    let ok: Bool
    let account: String
    let jsonPath: String
    let secretFile: String
    let detail: BotDetail
}

struct ProbeResult: Decodable, Equatable, Sendable {
    let ok: Bool
    let account: String
    let exitCode: Int
    let facts: [String: String]
    let output: [String]
}

struct EnvironmentCheck: Decodable, Equatable, Sendable {
    let passed: Bool
    let label: String
    let detail: String
    let raw: [String]
}

struct EnvironmentHealth: Decodable, Equatable, Sendable {
    let account: String
    let ok: Bool
    let status: String
    let summary: String
    let hint: String
    let codexBin: String
    let codexVersion: String
    let binary: EnvironmentCheck
    let login: EnvironmentCheck
    let connectivity: EnvironmentCheck
}

struct ThreadListResponse: Decodable, Equatable, Sendable {
    let ok: Bool?
    let account: String
    let filePath: String
    let recentTargets: [ChatTarget]
    let threads: [StudioThread]
    let thread: StudioThread?
}

struct ChatTarget: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let chatId: String
    let chatType: String
    let label: String
    let detail: String
}

struct StudioThread: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let chatId: String
    let chatType: String
    let chatLabel: String
    let codexThreadId: String
    let status: String
    let lastError: String
    let lastReplyPreview: String
    let createdAt: String
    let updatedAt: String
    let history: [ThreadHistoryItem]
    let turnCount: Int
}

struct ThreadHistoryItem: Decodable, Equatable, Sendable, Identifiable {
    let role: String
    let text: String

    var id: String {
        "\(role)-\(text)"
    }
}

struct ThreadActionEnvelope: Decodable, Sendable {
    let ok: Bool
    let account: String
    let filePath: String
    let recentTargets: [ChatTarget]
    let threads: [StudioThread]
    let thread: StudioThread?
}

struct ThreadSendEnvelope: Decodable, Sendable {
    let ok: Bool
    let account: String
    let filePath: String
    let recentTargets: [ChatTarget]
    let threads: [StudioThread]
    let thread: StudioThread?
    let sentChunks: Int
    let preview: String
}

struct SavePayload: Codable, Sendable {
    let profile: BotEditor
}

struct ThreadCreatePayload: Codable, Sendable {
    let name: String
    let chatId: String
    let chatType: String
    let chatLabel: String
}

struct ThreadSendPayload: Codable, Sendable {
    let threadId: String
    let text: String
}

struct ThreadClosePayload: Codable, Sendable {
    let threadId: String
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case overview = "概览"
    case configuration = "配置"
    case threads = "线程"
    case logs = "日志"

    var id: String { rawValue }
}

struct BannerMessage: Identifiable, Equatable {
    enum Tone {
        case success
        case warning
        case error
    }

    let id = UUID()
    let tone: Tone
    let text: String
}
