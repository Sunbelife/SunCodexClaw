import Combine
import Foundation

@MainActor
final class StudioStore: ObservableObject {
    @Published var runtime: StudioRuntime?
    @Published var summary: SummaryResponse?
    @Published var selectedAccount: String?
    @Published var selectedDetail: BotDetail?
    @Published var threadList: ThreadListResponse?
    @Published var environmentHealth: EnvironmentHealth?
    @Published var probeResult: ProbeResult?
    @Published var banner: BannerMessage?
    @Published var startupError: String?
    @Published var isLoading = false
    @Published var isCheckingEnvironment = false
    @Published var isPerformingAction = false
    @Published var showAddRobotSheet = false
    @Published var showOnboarding = false

    private let bridge = BridgeClient()
    private var refreshTask: Task<Void, Never>?
    private let onboardingDefaultsKey = "studio.onboarding.completed"

    deinit {
        refreshTask?.cancel()
    }

    var hasAccounts: Bool {
        !(summary?.accounts.isEmpty ?? true)
    }

    var canCreateBots: Bool {
        runtime != nil && environmentHealth?.ok == true
    }

    var monitorState: String {
        if startupError != nil || environmentHealth?.ok == false {
            return "error"
        }
        if isCheckingEnvironment || isLoading || isPerformingAction {
            return "checking"
        }
        if summary?.accounts.contains(where: { $0.activity.state == "warning" }) == true {
            return "warning"
        }
        if summary?.accounts.contains(where: { $0.status.state == "running" || $0.activity.state == "busy" }) == true {
            return "healthy"
        }
        return "idle"
    }

    var monitorLabel: String {
        switch monitorState {
        case "error":
            return environmentHealth?.summary ?? startupError ?? "环境异常"
        case "checking":
            return "检测中"
        case "warning":
            return "运行中，存在告警"
        case "healthy":
            return "运行正常"
        default:
            return canCreateBots ? "等待启动" : "待配置"
        }
    }

    func start() {
        refreshTask?.cancel()

        Task {
            isLoading = true
            defer { isLoading = false }

            do {
                let preparedRuntime = try await Task.detached(priority: .userInitiated) {
                    try RuntimeInstaller.prepare()
                }.value

                runtime = preparedRuntime
                startupError = nil

                if preparedRuntime.didRefreshRuntime {
                    banner = BannerMessage(
                        tone: .success,
                        text: preparedRuntime.isFreshInstall
                            ? "Studio 已把独立运行时安装到 \(preparedRuntime.rootURL.path)。"
                            : "Studio 运行时已更新，现有配置保持不变。"
                    )
                }

                await refreshEnvironmentHealth(quietly: false)

                let onboardingDismissed = UserDefaults.standard.bool(forKey: onboardingDefaultsKey)
                showOnboarding = preparedRuntime.isFreshInstall || !onboardingDismissed || environmentHealth?.ok != true

                await reload(selectFirstIfNeeded: true)
                startRefreshLoop()
            } catch {
                startupError = error.localizedDescription
                banner = BannerMessage(tone: .error, text: error.localizedDescription)
            }
        }
    }

    func reopenOnboarding() {
        showOnboarding = true
    }

    func dismissOnboarding(openRobotCreator: Bool = false) {
        UserDefaults.standard.set(true, forKey: onboardingDefaultsKey)
        showOnboarding = false
        if openRobotCreator {
            if canCreateBots {
                showAddRobotSheet = true
            } else {
                banner = BannerMessage(tone: .warning, text: environmentHealth?.hint ?? "先完成 Codex 环境检测，再创建机器人。")
            }
        }
    }

    func refreshEnvironmentHealth(quietly: Bool = false) async {
        guard let runtime else { return }
        if !quietly { isCheckingEnvironment = true }
        defer { if !quietly { isCheckingEnvironment = false } }

        do {
            environmentHealth = try await bridge.loadEnvironmentHealth(runtime: runtime)
        } catch {
            environmentHealth = nil
            if !quietly {
                banner = BannerMessage(tone: .error, text: error.localizedDescription)
            }
        }
    }

    func selectAccount(_ account: String) {
        selectedAccount = account
        threadList = nil
        if probeResult?.account != account {
            probeResult = nil
        }
        Task {
            await loadDetail(account: account)
        }
    }

    func reload(selectFirstIfNeeded: Bool = false, quietly: Bool = false) async {
        guard let runtime else { return }
        if !quietly { isLoading = true }
        defer { if !quietly { isLoading = false } }

        do {
            let latestSummary = try await bridge.loadSummary(runtime: runtime)
            summary = latestSummary

            let knownAccounts = Set(latestSummary.accounts.map(\.account))
            if let selectedAccount, !knownAccounts.contains(selectedAccount) {
                self.selectedAccount = nil
                selectedDetail = nil
                threadList = nil
                probeResult = nil
            }

            if selectFirstIfNeeded, selectedAccount == nil {
                selectedAccount = latestSummary.accounts.first?.account
            }

            if let selectedAccount {
                await loadDetail(account: selectedAccount, quietly: quietly)
            } else {
                selectedDetail = nil
                threadList = nil
            }
        } catch {
            if !quietly {
                banner = BannerMessage(tone: .error, text: error.localizedDescription)
            }
        }
    }

    func loadDetail(account: String, quietly: Bool = false) async {
        guard let runtime else { return }
        if !quietly { isLoading = true }
        defer { if !quietly { isLoading = false } }

        do {
            async let detailTask = bridge.loadDetail(account: account, runtime: runtime)
            async let threadTask = bridge.loadThreads(account: account, runtime: runtime)

            selectedDetail = try await detailTask
            threadList = try await threadTask

            if selectedAccount == account {
                selectedAccount = account
            }
        } catch {
            if !quietly {
                banner = BannerMessage(tone: .error, text: error.localizedDescription)
            }
        }
    }

    func save(account: String, editor: BotEditor, isNew: Bool = false) async {
        guard let runtime else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            let saved = try await bridge.save(account: account, editor: editor, runtime: runtime)
            selectedAccount = account
            selectedDetail = saved.detail
            banner = BannerMessage(
                tone: .success,
                text: isNew
                    ? "机器人 \(account) 已创建到 Studio 运行时。当前不会自动重启任何现有机器人。"
                    : "配置已保存到 Studio 运行时。现有运行中的机器人不会自动重启。"
            )
            probeResult = nil
            await reload(selectFirstIfNeeded: false, quietly: true)
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
        }
    }

    func control(_ action: BotControlAction, account: String) async {
        guard let runtime else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            let response = try await bridge.control(action, account: account, runtime: runtime)
            selectedDetail = response.detail
            banner = BannerMessage(tone: .success, text: "\(account) 已执行 \(action.rawValue)。")
            await reload(selectFirstIfNeeded: false, quietly: true)
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
        }
    }

    func probe(account: String) async {
        guard let runtime else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            probeResult = try await bridge.probe(account: account, runtime: runtime)
            banner = BannerMessage(tone: .success, text: "dry-run 校验已完成。")
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
        }
    }

    func createThread(account: String, name: String, chatId: String, chatType: String, chatLabel: String) async {
        guard let runtime else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            let response = try await bridge.createThread(
                account: account,
                payload: ThreadCreatePayload(name: name, chatId: chatId, chatType: chatType, chatLabel: chatLabel),
                runtime: runtime
            )
            threadList = ThreadListResponse(
                ok: response.ok,
                account: response.account,
                filePath: response.filePath,
                recentTargets: response.recentTargets,
                threads: response.threads,
                thread: response.thread
            )
            banner = BannerMessage(tone: .success, text: "新线程已创建。")
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
        }
    }

    func closeThread(account: String, threadId: String) async {
        guard let runtime else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            let response = try await bridge.closeThread(account: account, threadId: threadId, runtime: runtime)
            threadList = ThreadListResponse(
                ok: response.ok,
                account: response.account,
                filePath: response.filePath,
                recentTargets: response.recentTargets,
                threads: response.threads,
                thread: response.thread
            )
            banner = BannerMessage(tone: .success, text: "线程已关闭。")
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
        }
    }

    func sendThreadMessage(account: String, threadId: String, text: String) async -> Bool {
        guard let runtime else { return false }
        isPerformingAction = true
        defer { isPerformingAction = false }

        do {
            let response = try await bridge.sendThreadMessage(account: account, threadId: threadId, text: text, runtime: runtime)
            threadList = ThreadListResponse(
                ok: response.ok,
                account: response.account,
                filePath: response.filePath,
                recentTargets: response.recentTargets,
                threads: response.threads,
                thread: response.thread
            )
            banner = BannerMessage(tone: .success, text: "消息已通过飞书发出，机器人回复已推送到目标聊天。")
            return true
        } catch {
            banner = BannerMessage(tone: .error, text: error.localizedDescription)
            return false
        }
    }

    func clearBanner() {
        banner = nil
    }

    private func startRefreshLoop() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                await self.reload(selectFirstIfNeeded: false, quietly: true)
            }
        }
    }
}
