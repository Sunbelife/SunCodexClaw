import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StudioStore

    var body: some View {
        ZStack {
            background
            mainWorkspace
                .blur(radius: store.showOnboarding ? 6 : 0)
                .allowsHitTesting(!store.showOnboarding)

            if store.showOnboarding {
                WelcomeOverlay()
                    .environmentObject(store)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .sheet(isPresented: $store.showAddRobotSheet) {
            AddRobotSheet()
                .environmentObject(store)
        }
        .overlay(alignment: .top) {
            if let banner = store.banner {
                BannerView(banner: banner)
                    .padding(.top, 14)
                    .onTapGesture {
                        store.clearBanner()
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.34), value: store.banner)
        .animation(.spring(duration: 0.4), value: store.showOnboarding)
    }

    private var background: some View {
        LinearGradient(
            colors: [
                Color(red: 0.96, green: 0.98, blue: 1.0),
                Color(red: 0.92, green: 0.95, blue: 0.98),
                Color(red: 0.90, green: 0.92, blue: 0.97)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(Color.white.opacity(0.55))
                .frame(width: 380, height: 380)
                .blur(radius: 80)
                .offset(x: 120, y: -120)
        }
        .ignoresSafeArea()
    }

    private var mainWorkspace: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            detailView
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    store.reopenOnboarding()
                } label: {
                    Label("上手", systemImage: "sparkles")
                }

                Button {
                    Task { await store.refreshEnvironmentHealth() }
                } label: {
                    Label("检测 Codex", systemImage: "bolt.badge.checkmark")
                }

                Button {
                    Task { await store.reload(selectFirstIfNeeded: true) }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button {
                    store.showAddRobotSheet = true
                } label: {
                    Label("新增机器人", systemImage: "plus")
                }
                .disabled(!store.canCreateBots)
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let startupError = store.startupError {
            EmptyStateView(
                title: "Studio 启动失败",
                subtitle: startupError,
                actionTitle: "重新加载"
            ) {
                store.start()
            }
        } else if store.runtime == nil {
            ProgressStateView(
                title: "正在准备 Studio 运行时",
                subtitle: "首次启动会把运行器安装到 Application Support，并保持和当前仓库分离。"
            )
        } else if store.summary == nil && store.isLoading {
            ProgressStateView(
                title: "正在读取机器人列表",
                subtitle: "Studio 正在从自己的运行时里加载配置、日志和当前状态。"
            )
        } else if let detail = store.selectedDetail {
            BotDetailView(detail: detail)
                .environmentObject(store)
        } else if store.summary?.accounts.isEmpty == true {
            StudioZeroStateView()
                .environmentObject(store)
        } else {
            EmptyStateView(
                title: "选择一个机器人",
                subtitle: "左边可以查看每个 Studio 机器人正在执行的任务、运行状态和最近错误。",
                actionTitle: "新增机器人"
            ) {
                store.showAddRobotSheet = true
            }
            .opacity(store.canCreateBots ? 1 : 0.85)
        }
    }
}

private struct SidebarView: View {
    @EnvironmentObject private var store: StudioStore

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let summary = store.summary {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(summary.accounts) { bot in
                            BotRow(bot: bot, selected: store.selectedAccount == bot.account)
                                .environmentObject(store)
                        }
                    }
                    .padding(.vertical, 6)
                }
            } else {
                Spacer()
                ProgressView("正在读取机器人列表…")
                    .frame(maxWidth: .infinity)
                Spacer()
            }
        }
        .padding(18)
    }

    private var header: some View {
        GlassCard(padding: 18) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SunCodexClaw Studio")
                            .font(.system(size: 26, weight: .bold, design: .rounded))
                        Text("App 自带运行时，默认不接管当前仓库里的机器人。")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 8) {
                        MonitorStatusLight(state: store.monitorState, label: store.monitorLabel)
                        Image(systemName: "rectangle.3.group.bubble.left.fill")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                }

                Divider()

                HStack(spacing: 16) {
                    stat(title: "机器人", value: "\(store.summary?.accounts.count ?? 0)")
                    stat(title: "运行中", value: "\(store.summary?.accounts.filter { $0.status.state == "running" }.count ?? 0)")
                    stat(title: "告警", value: "\(store.summary?.accounts.filter { $0.activity.state == "warning" }.count ?? 0)")
                }

                if let runtime = store.runtime {
                    Text("运行时：\(runtime.rootURL.path)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text("launchctl：\(runtime.launchctlPrefix)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                if let health = store.environmentHealth {
                    Divider()
                    HStack(alignment: .top, spacing: 12) {
                        StatusBullet(passed: health.binary.passed)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(health.summary)
                                .font(.system(.body, design: .rounded).weight(.semibold))
                            Text(health.hint)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(.secondary)
                            Text("Codex: \(health.codexVersion.isEmpty ? health.codexBin : health.codexVersion)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func stat(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BotRow: View {
    @EnvironmentObject private var store: StudioStore

    let bot: BotSummary
    let selected: Bool

    var body: some View {
        GlassCard(padding: 14, tint: selected ? Color.accentColor.opacity(0.14) : Color.white.opacity(0.62)) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(bot.displayName)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .foregroundStyle(Color.primary)
                        Text(bot.account)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    HStack(spacing: 8) {
                        MonitorDot(state: bot.activity.state == "warning" ? "warning" : bot.activity.state == "busy" ? "busy" : bot.status.state)
                        StatusBadge(state: bot.activity.state == "busy" ? "busy" : bot.status.state)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text(bot.activity.label)
                        .font(.system(.subheadline, design: .rounded))
                    if !bot.activity.detail.isEmpty {
                        Text(bot.activity.detail)
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(.secondary)
                    }
                }

                Divider()

                HStack(spacing: 10) {
                    DetailChip(label: bot.boot.codexModel.isEmpty ? "模型未读出" : bot.boot.codexModel)
                    if !bot.boot.progressMode.isEmpty {
                        DetailChip(label: "进度 \(bot.boot.progressMode)")
                    }
                    DetailChip(label: "\(bot.checklistDone)/\(bot.checklistTotal)")
                    Spacer()
                    InlineRunButton(
                        isRunning: bot.status.state == "running",
                        isBusy: store.isPerformingAction
                    ) {
                        Task {
                            await store.control(bot.status.state == "running" ? .stop : .start, account: bot.account)
                        }
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            store.selectAccount(bot.account)
        }
    }
}

private struct BotDetailView: View {
    @EnvironmentObject private var store: StudioStore

    let detail: BotDetail

    @State private var selectedTab: InspectorTab = .overview
    @State private var draft: BotEditor = .empty
    @State private var isDirty = false

    private let bridge = BridgeClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                hero
                Picker("视图", selection: $selectedTab) {
                    ForEach(InspectorTab.allCases) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)

                switch selectedTab {
                case .overview:
                    overview
                case .configuration:
                    configuration
                case .threads:
                    ThreadInspectorView(account: detail.account)
                        .environmentObject(store)
                case .logs:
                    logs
                }
            }
            .padding(22)
        }
        .onAppear {
            draft = detail.editor
        }
        .onChange(of: detail.account) { _, _ in
            draft = detail.editor
            isDirty = false
        }
        .onChange(of: detail.editor) { _, newValue in
            if !isDirty {
                draft = newValue
            }
        }
    }

    private var hero: some View {
        GlassCard(padding: 22, tint: Color.white.opacity(0.66)) {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 20) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Text(detail.displayName)
                                .font(.system(size: 34, weight: .bold, design: .rounded))
                            StatusBadge(state: detail.activity.summary.state == "warning" ? "warning" : detail.status.state)
                        }
                        Text(detail.account)
                            .font(.system(.headline, design: .monospaced))
                            .foregroundStyle(.secondary)
                        Text(detail.activity.summary.label)
                            .font(.system(.title3, design: .rounded))
                        if !detail.activity.summary.detail.isEmpty {
                            Text(detail.activity.summary.detail)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 10) {
                        Toggle(isOn: runBinding) {
                            Text(detail.status.state == "running" ? "机器人运行中" : "机器人已停止")
                                .font(.system(.body, design: .rounded))
                        }
                        .toggleStyle(.switch)
                        actionRow
                        Text("保存只写入 Studio 运行时；是否启动由你手动决定。")
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 12) {
                    RuntimeStatCard(title: "PID", value: detail.status.pid.map(String.init) ?? "—", subtitle: detail.status.manager)
                    RuntimeStatCard(title: "工作目录", value: draft.codex.cwd.isEmpty ? "未设置" : draft.codex.cwd, subtitle: draft.codex.model)
                    RuntimeStatCard(title: "配置文件", value: URL(fileURLWithPath: detail.paths.jsonConfig).lastPathComponent, subtitle: "Secrets: \(URL(fileURLWithPath: detail.paths.secretFile).lastPathComponent)")
                }
            }
        }
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            ActionButton(title: "重启", systemImage: "arrow.clockwise", role: nil) {
                Task { await store.control(.restart, account: detail.account) }
            }

            ActionButton(title: "校验", systemImage: "checkmark.seal.fill", role: nil) {
                Task { await store.probe(account: detail.account) }
            }
        }
        .disabled(store.isPerformingAction)
    }

    private var runBinding: Binding<Bool> {
        Binding(
            get: { detail.status.state == "running" },
            set: { nextValue in
                Task {
                    await store.control(nextValue ? .start : .stop, account: detail.account)
                }
            }
        )
    }

    private var overview: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 18) {
            overviewTaskCard
            overviewGuideCard
            overviewChecklistCard
            overviewPathsCard
        }
    }

    private var overviewTaskCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionTitle("执行状态", icon: "waveform.path.ecg.rectangle")
                VStack(alignment: .leading, spacing: 10) {
                    infoRow("当前摘要", detail.activity.summary.label)
                    if let event = detail.activity.activeEvent {
                        infoRow("当前消息类型", event.messageType)
                        infoRow("会话范围", event.chatScopeKind ?? "—")
                        if let thread = event.codexThreadId, !thread.isEmpty {
                            infoRow("Codex 线程", thread)
                        }
                    } else if let event = detail.activity.lastEvent {
                        infoRow("最近一次消息", event.messageType)
                        infoRow("最近状态", event.state)
                        if let thread = event.codexThreadId, !thread.isEmpty {
                            infoRow("最近线程", thread)
                        }
                    }

                    if let lastError = detail.activity.lastError, !lastError.summary.isEmpty {
                        callout(text: lastError.code.isEmpty ? lastError.summary : "\(lastError.code) · \(lastError.summary)", tone: .warning)
                    } else {
                        callout(text: "当前没有新的运行错误，状态从日志实时推断。", tone: .success)
                    }
                }
            }
        }
    }

    private var overviewGuideCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionTitle("用户引导", icon: "sparkles.rectangle.stack")
                GuideStep(index: 1, title: "Studio 自带运行时", detail: "配置、日志和 launchctl 标签都写到 App Support，不需要再导入仓库。")
                GuideStep(index: 2, title: "先建机器人再补配置", detail: "账号名、机器人名称、飞书凭据和 Codex 工作目录是第一批必填项。")
                GuideStep(index: 3, title: "先做 dry-run，再决定是否启动", detail: "校验不会重启任何现有进程，Studio 也不会自动接管仓库版机器人。")
                GuideStep(index: 4, title: "同一飞书账号不要双开", detail: "如果仓库版和 Studio 版同时启动同一机器人，会重复响应消息。")
            }
        }
    }

    private var overviewChecklistCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionTitle("配置检查", icon: "checklist")
                ForEach(detail.checklist) { item in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: item.done ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(item.done ? Color.green : Color.orange)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title)
                                .font(.system(.body, design: .rounded))
                            Text(item.hint)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Spacer()
                    }
                }
            }
        }
    }

    private var overviewPathsCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionTitle("工作区与文件", icon: "folder.badge.gearshape")
                infoRow("Studio 运行时", detail.paths.repo, monospaced: true)
                infoRow("Codex 目录", draft.codex.cwd.isEmpty ? "未设置" : draft.codex.cwd, monospaced: true)
                infoRow("附加目录", draft.codex.addDirs.isEmpty ? "无" : draft.codex.addDirs.joined(separator: "\n"), monospaced: true)
                infoRow("JSON 配置", detail.paths.jsonConfig, monospaced: true)
                infoRow("Secrets", detail.paths.secretFile, monospaced: true)
                infoRow("日志", detail.paths.logFile, monospaced: true)
            }
        }
    }

    private var configuration: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let health = store.environmentHealth, !health.ok {
                callout(text: health.hint, tone: .warning)
            }
            callout(text: "保存配置只会写入 Studio 运行时里的 `config/feishu/<account>.json` 和 `config/secrets/local.yaml`。不会自动重启当前进程；如果你要切换到 Studio，再手动启动。", tone: .success)

            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("飞书接入", icon: "person.crop.rectangle.stack")
                    LabeledField(title: "机器人名称", text: $draft.botName) { isDirty = true }
                    LabeledField(title: "App ID", text: $draft.appId, secure: true) { isDirty = true }
                    LabeledField(title: "App Secret", text: $draft.appSecret, secure: true) { isDirty = true }
                    LabeledField(title: "Encrypt Key", text: $draft.encryptKey, secure: true) { isDirty = true }
                    LabeledField(title: "Verification Token", text: $draft.verificationToken, secure: true) { isDirty = true }
                    LabeledField(title: "Bot Open ID", text: $draft.botOpenId) { isDirty = true }
                    HStack(spacing: 12) {
                        LabeledField(title: "域名", text: $draft.domain) { isDirty = true }
                        LabeledField(title: "回复前缀", text: $draft.replyPrefix) { isDirty = true }
                    }
                }
            }

            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("行为策略", icon: "switch.2")
                    ToggleRow(title: "自动回复", isOn: $draft.autoReply) { isDirty = true }
                    ToggleRow(title: "忽略机器人自己消息", isOn: $draft.ignoreSelfMessages) { isDirty = true }
                    ToggleRow(title: "必须 @ 才响应", isOn: $draft.requireMention) { isDirty = true }
                    ToggleRow(title: "仅群聊要求 @", isOn: $draft.requireMentionGroupOnly) { isDirty = true }
                    ToggleRow(title: "启用进度通知", isOn: $draft.progress.enabled) { isDirty = true }
                    HStack(spacing: 12) {
                        LabeledField(title: "回复模式", text: $draft.replyMode) { isDirty = true }
                        LabeledField(title: "进度模式", text: $draft.progress.mode) { isDirty = true }
                    }
                    LabeledField(title: "进度消息", text: $draft.progress.message) { isDirty = true }
                    LabeledField(title: "进度文档标题", text: $draft.progress.doc.titlePrefix) { isDirty = true }
                    HStack(spacing: 12) {
                        LabeledField(title: "链接范围", text: $draft.progress.doc.linkScope) { isDirty = true }
                        ToggleRow(title: "分享到聊天", isOn: $draft.progress.doc.shareToChat) { isDirty = true }
                    }
                    ToggleRow(title: "文档包含用户消息", isOn: $draft.progress.doc.includeUserMessage) { isDirty = true }
                    ToggleRow(title: "文档记录最终回复", isOn: $draft.progress.doc.writeFinalReply) { isDirty = true }
                }
            }

            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("Codex", icon: "terminal")
                    HStack(spacing: 12) {
                        LabeledField(title: "可执行文件", text: $draft.codex.bin) { isDirty = true }
                        LabeledField(title: "模型", text: $draft.codex.model) { isDirty = true }
                        LabeledField(title: "推理强度", text: $draft.codex.reasoningEffort) { isDirty = true }
                    }
                    HStack(spacing: 12) {
                        LabeledField(title: "Profile", text: $draft.codex.profile) { isDirty = true }
                        LabeledField(title: "Sandbox", text: $draft.codex.sandbox) { isDirty = true }
                        LabeledField(title: "Approval", text: $draft.codex.approvalPolicy) { isDirty = true }
                    }
                    HStack(spacing: 12) {
                        PathField(title: "工作目录", text: $draft.codex.cwd) {
                            if let chosen = bridge.chooseDirectory(current: draft.codex.cwd) {
                                draft.codex.cwd = chosen
                                isDirty = true
                            }
                        }
                        NumericField(title: "History Turns", value: $draft.codex.historyTurns) { isDirty = true }
                    }
                    LabeledField(title: "Codex API Key", text: $draft.codex.apiKey, secure: true) { isDirty = true }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("附加目录")
                                .font(.system(.headline, design: .rounded))
                            Spacer()
                            Button("添加目录") {
                                if let chosen = bridge.chooseDirectory(current: draft.codex.cwd) {
                                    draft.codex.addDirs.append(chosen)
                                    draft.codex.addDirs = Array(Set(draft.codex.addDirs)).sorted()
                                    isDirty = true
                                }
                            }
                        }
                        if draft.codex.addDirs.isEmpty {
                            Text("未配置额外目录")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(draft.codex.addDirs.enumerated()), id: \.offset) { index, dir in
                                HStack {
                                    Text(dir)
                                        .font(.system(.caption, design: .monospaced))
                                        .textSelection(.enabled)
                                    Spacer()
                                    Button(role: .destructive) {
                                        draft.codex.addDirs.remove(at: index)
                                        isDirty = true
                                    } label: {
                                        Image(systemName: "minus.circle.fill")
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("系统提示词")
                            .font(.system(.headline, design: .rounded))
                        TextEditor(text: $draft.codex.systemPrompt)
                            .font(.system(.body, design: .rounded))
                            .frame(minHeight: 140)
                            .padding(10)
                            .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .onChange(of: draft.codex.systemPrompt) { _, _ in isDirty = true }
                    }
                }
            }

            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("语音", icon: "waveform.badge.mic")
                    ToggleRow(title: "启用语音转写", isOn: $draft.speech.enabled) { isDirty = true }
                    HStack(spacing: 12) {
                        LabeledField(title: "模型", text: $draft.speech.model) { isDirty = true }
                        LabeledField(title: "语言", text: $draft.speech.language) { isDirty = true }
                    }
                    HStack(spacing: 12) {
                        LabeledField(title: "Base URL", text: $draft.speech.baseUrl) { isDirty = true }
                        LabeledField(title: "FFmpeg", text: $draft.speech.ffmpegBin) { isDirty = true }
                    }
                    LabeledField(title: "Speech API Key", text: $draft.speech.apiKey, secure: true) { isDirty = true }
                }
            }

            HStack {
                Button("恢复到当前已保存配置") {
                    draft = detail.editor
                    isDirty = false
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    Task { await store.save(account: detail.account, editor: draft) }
                    isDirty = false
                } label: {
                    Label("保存配置", systemImage: "square.and.arrow.down.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isPerformingAction || !isDirty)
            }
        }
    }

    private var logs: some View {
        VStack(alignment: .leading, spacing: 18) {
            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        sectionTitle("dry-run 校验", icon: "checkmark.seal")
                        Spacer()
                        Button {
                            Task { await store.probe(account: detail.account) }
                        } label: {
                            Label("重新校验", systemImage: "arrow.triangle.2.circlepath")
                        }
                    }

                    if let probe = store.probeResult, probe.account == detail.account {
                        HStack(spacing: 16) {
                            DetailChip(label: probe.ok ? "通过" : "失败", accent: probe.ok ? .green : .orange)
                            DetailChip(label: "exit \(probe.exitCode)")
                            if let cwd = probe.facts["codex_cwd"], !cwd.isEmpty {
                                DetailChip(label: cwd)
                            }
                        }
                        codeBlock(lines: probe.output)
                    } else {
                        Text("点右上角“校验”会执行 `--dry-run`，只验证配置，不会影响当前运行中的机器人。")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    sectionTitle("最近日志", icon: "doc.text.magnifyingglass")
                    HStack {
                        DetailChip(label: detail.paths.logFile)
                        if !detail.activity.logUpdatedAt.isEmpty {
                            DetailChip(label: detail.activity.logUpdatedAt)
                        }
                    }
                    codeBlock(lines: detail.activity.logExcerpt)
                }
            }
        }
    }

    private func sectionTitle(_ text: String, icon: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(text)
                .font(.system(.title3, design: .rounded).weight(.semibold))
        }
    }

    private func infoRow(_ title: String, _ value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value.isEmpty ? "—" : value)
                .font(monospaced ? .system(.body, design: .monospaced) : .system(.body, design: .rounded))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func codeBlock(lines: [String]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 220)
        .background(Color.black.opacity(0.86), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .foregroundStyle(Color.white.opacity(0.92))
    }

    private func callout(text: String, tone: BannerMessage.Tone) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tone == .success ? "checkmark.shield.fill" : tone == .warning ? "exclamationmark.triangle.fill" : "xmark.octagon.fill")
                .foregroundStyle(toneColor(tone))
            Text(text)
                .font(.system(.body, design: .rounded))
                .foregroundStyle(Color.primary)
                .textSelection(.enabled)
        }
        .padding(14)
        .background(toneColor(tone).opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func toneColor(_ tone: BannerMessage.Tone) -> Color {
        switch tone {
        case .success: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }
}

private struct AddRobotSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: StudioStore

    @State private var account = ""
    @State private var draft = BotEditor.empty

    private let bridge = BridgeClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("新增机器人")
                .font(.system(size: 28, weight: .bold, design: .rounded))

            callout

            LabeledField(title: "账号名", text: $account)
            LabeledField(title: "机器人名称", text: $draft.botName)
            LabeledField(title: "回复前缀", text: $draft.replyPrefix)
            PathField(title: "Codex 工作目录", text: $draft.codex.cwd) {
                if let chosen = bridge.chooseDirectory(current: draft.codex.cwd) {
                    draft.codex.cwd = chosen
                }
            }

            HStack(spacing: 12) {
                LabeledField(title: "App ID", text: $draft.appId, secure: true)
                LabeledField(title: "App Secret", text: $draft.appSecret, secure: true)
            }
            HStack(spacing: 12) {
                LabeledField(title: "Encrypt Key", text: $draft.encryptKey, secure: true)
                LabeledField(title: "Verification Token", text: $draft.verificationToken, secure: true)
            }

            Spacer()

            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button {
                    Task {
                        await store.save(account: account, editor: draft, isNew: true)
                        dismiss()
                    }
                } label: {
                    Label("创建机器人", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canCreateBots || account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.botName.isEmpty || draft.codex.cwd.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 720, height: 520)
        .background(
            LinearGradient(
                colors: [Color.white, Color(red: 0.94, green: 0.96, blue: 1)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }

    private var callout: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: store.canCreateBots ? "shield.lefthalf.filled" : "exclamationmark.triangle.fill")
                .foregroundStyle(store.canCreateBots ? .green : .orange)
            Text(store.canCreateBots
                 ? "创建动作只会写到 Studio 自己的运行时，不会自动启动机器人。先把最小必填项写进去，创建后再继续补进度、语音和更多运行参数。"
                 : (store.environmentHealth?.hint ?? "先通过 Codex 安装和连通性检测，再创建机器人。"))
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background((store.canCreateBots ? Color.green : Color.orange).opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct ThreadInspectorView: View {
    @EnvironmentObject private var store: StudioStore

    let account: String

    @State private var selectedThreadID = ""
    @State private var draftMessage = ""
    @State private var showCreateThreadSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            GlassCard {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        sectionTitle
                        Spacer()
                        Button {
                            Task { await store.loadDetail(account: account, quietly: true) }
                        } label: {
                            Label("刷新线程", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)

                        Button {
                            showCreateThreadSheet = true
                        } label: {
                            Label("新建线程", systemImage: "plus.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    if let health = store.environmentHealth, !health.ok {
                        warningCallout(text: health.hint)
                    } else {
                        successCallout(text: "在这里可以给当前机器人创建 App 侧线程，指定 Feishu 目标聊天后直接发任务，回复会由机器人账号推回 Feishu。")
                    }
                }
            }

            if let threadList = store.threadList {
                HStack(alignment: .top, spacing: 18) {
                    threadSidebar(threadList)
                    threadComposer(threadList)
                }
            } else {
                ProgressStateView(
                    title: "正在读取线程",
                    subtitle: "Studio 正在加载这个机器人的 App 侧线程和最近可用聊天。"
                )
            }
        }
        .sheet(isPresented: $showCreateThreadSheet) {
            CreateThreadSheet(account: account)
                .environmentObject(store)
        }
        .onAppear {
            syncSelectedThread()
        }
        .onChange(of: store.threadList?.threads.map(\.id) ?? []) { _, _ in
            syncSelectedThread()
        }
    }

    private var currentThread: StudioThread? {
        store.threadList?.threads.first(where: { $0.id == selectedThreadID }) ?? store.threadList?.threads.first
    }

    private var sectionTitle: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text("线程派发")
                .font(.system(.title3, design: .rounded).weight(.semibold))
        }
    }

    private func threadSidebar(_ threadList: ThreadListResponse) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("线程列表")
                    .font(.system(.headline, design: .rounded))

                if threadList.threads.isEmpty {
                    Text("还没有线程。先新建一个线程，并绑定要回复到的 Feishu 聊天。")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(threadList.threads) { thread in
                        Button {
                            selectedThreadID = thread.id
                        } label: {
                            ThreadRow(thread: thread, selected: selectedThreadID == thread.id)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxWidth: 340, alignment: .leading)
        }
    }

    private func threadComposer(_ threadList: ThreadListResponse) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                if let thread = currentThread {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(thread.name)
                                .font(.system(size: 24, weight: .bold, design: .rounded))
                            Text(thread.id)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text(thread.chatLabel.isEmpty ? thread.chatId : "\(thread.chatLabel) · \(thread.chatId)")
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { await store.closeThread(account: account, threadId: thread.id) }
                        } label: {
                            Label("关闭线程", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)
                    }

                    HStack(spacing: 10) {
                        DetailChip(label: "\(thread.turnCount) 轮")
                        if !thread.codexThreadId.isEmpty {
                            DetailChip(label: "Codex \(thread.codexThreadId.prefix(8))")
                        }
                        DetailChip(label: thread.chatType.uppercased(), accent: .green)
                        DetailChip(label: thread.statusLabel, accent: thread.statusColor)
                    }

                    if !thread.lastError.isEmpty {
                        warningCallout(text: thread.lastError)
                    } else if !thread.lastReplyPreview.isEmpty {
                        successCallout(text: "最近回复：\(thread.lastReplyPreview)")
                    }

                    if !threadList.recentTargets.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("最近聊天")
                                .font(.system(.headline, design: .rounded))
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(threadList.recentTargets) { target in
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(target.label)
                                                .font(.system(.caption, design: .rounded).weight(.semibold))
                                            Text(target.chatId)
                                                .font(.system(.caption2, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 8)
                                        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("在 App 里发起任务")
                            .font(.system(.headline, design: .rounded))
                        TextEditor(text: $draftMessage)
                            .font(.system(.body, design: .rounded))
                            .frame(minHeight: 180)
                            .padding(10)
                            .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                        HStack {
                            Text("发送后，机器人会把回复发回这个线程绑定的 Feishu 聊天。")
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                Task {
                                    let sent = await store.sendThreadMessage(account: account, threadId: thread.id, text: draftMessage)
                                    if sent {
                                        draftMessage = ""
                                    }
                                }
                            } label: {
                                Label("通过飞书发送", systemImage: "paperplane.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isPerformingAction)
                        }
                    }

                    if !thread.history.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("线程上下文")
                                .font(.system(.headline, design: .rounded))
                            codeHistory(thread.history)
                        }
                    }
                } else {
                    Text("先新建一个线程，然后选择目标聊天，再从 App 内发任务。")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func syncSelectedThread() {
        guard let threads = store.threadList?.threads, !threads.isEmpty else {
            selectedThreadID = ""
            return
        }
        if threads.contains(where: { $0.id == selectedThreadID }) {
            return
        }
        selectedThreadID = threads.first?.id ?? ""
    }

    private func codeHistory(_ history: [ThreadHistoryItem]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(history.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.role == "assistant" ? "助手" : "用户")
                            .font(.system(.caption, design: .rounded).weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(item.text)
                            .font(.system(.caption, design: .rounded))
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(14)
        }
        .frame(minHeight: 160)
        .background(Color.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .foregroundStyle(.white.opacity(0.92))
    }

    private func successCallout(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.shield.fill")
                .foregroundStyle(.green)
            Text(text)
                .font(.system(.body, design: .rounded))
        }
        .padding(14)
        .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func warningCallout(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(text)
                .font(.system(.body, design: .rounded))
        }
        .padding(14)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct CreateThreadSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: StudioStore

    let account: String

    @State private var name = ""
    @State private var chatId = ""
    @State private var chatType = "p2p"
    @State private var chatLabel = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("新建线程")
                .font(.system(size: 28, weight: .bold, design: .rounded))

            Text("每个线程都绑定一个 Feishu 聊天。你可以直接填 chat_id，也可以从下面最近聊天里点选带入。")
                .foregroundStyle(.secondary)

            LabeledField(title: "线程名称", text: $name)
            LabeledField(title: "聊天 ID", text: $chatId)
            HStack(spacing: 12) {
                LabeledField(title: "聊天备注", text: $chatLabel)
                LabeledField(title: "聊天类型", text: $chatType)
            }

            if let recentTargets = store.threadList?.recentTargets, !recentTargets.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("最近聊天")
                        .font(.system(.headline, design: .rounded))
                    ForEach(recentTargets) { target in
                        Button {
                            chatId = target.chatId
                            chatType = target.chatType
                            chatLabel = target.label
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(target.label)
                                        .font(.system(.body, design: .rounded))
                                    Text("\(target.chatType) · \(target.chatId)")
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if chatId == target.chatId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                }
                            }
                            .padding(12)
                            .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Spacer()

            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button {
                    Task {
                        await store.createThread(account: account, name: name, chatId: chatId, chatType: chatType, chatLabel: chatLabel)
                        dismiss()
                    }
                } label: {
                    Label("创建线程", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canCreateBots || chatId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 720, height: 560)
        .background(
            LinearGradient(
                colors: [Color.white, Color(red: 0.94, green: 0.96, blue: 1)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }
}

private struct ThreadRow: View {
    let thread: StudioThread
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(thread.name)
                    .font(.system(.body, design: .rounded).weight(.semibold))
                Spacer()
                DetailChip(label: thread.statusLabel, accent: thread.statusColor)
            }
            Text(thread.chatLabel.isEmpty ? thread.chatId : thread.chatLabel)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Text("\(thread.turnCount) 轮")
                    .font(.system(.caption2, design: .rounded))
                if !thread.lastReplyPreview.isEmpty {
                    Text(thread.lastReplyPreview)
                        .font(.system(.caption2, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(12)
        .background((selected ? Color.accentColor : Color.white).opacity(selected ? 0.16 : 0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private extension StudioThread {
    var statusLabel: String {
        switch status {
        case "running": return "发送中"
        case "error": return "失败"
        default: return "待命"
        }
    }

    var statusColor: Color {
        switch status {
        case "running": return .blue
        case "error": return .orange
        default: return .green
        }
    }
}

private struct EmptyStateView: View {
    let title: String
    let subtitle: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "macwindow.on.rectangle")
                .font(.system(size: 48, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(title)
                .font(.system(size: 30, weight: .bold, design: .rounded))
            Text(subtitle)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 520)
            Button(actionTitle, action: action)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ProgressStateView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 18) {
            ProgressView()
                .controlSize(.large)
            Text(title)
                .font(.system(size: 30, weight: .bold, design: .rounded))
            Text(subtitle)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 520)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct StudioZeroStateView: View {
    @EnvironmentObject private var store: StudioStore

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "sparkles.tv")
                .font(.system(size: 52, weight: .semibold))
                .foregroundStyle(Color.accentColor)

            Text("Studio 里还没有机器人")
                .font(.system(size: 32, weight: .bold, design: .rounded))

            Text("先创建一个独立机器人，把飞书凭据和 Codex 工作目录填进去。保存后先做 dry-run，再决定是否启动。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 560)

            if let runtime = store.runtime {
                DetailChip(label: runtime.rootURL.path)
            }

            HStack(spacing: 12) {
                Button {
                    store.showAddRobotSheet = true
                } label: {
                    Label("新增机器人", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canCreateBots)

                Button {
                    store.reopenOnboarding()
                } label: {
                    Label("查看启动引导", systemImage: "sparkles")
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

private struct WelcomeOverlay: View {
    @EnvironmentObject private var store: StudioStore

    var body: some View {
        ZStack {
            Color.black.opacity(0.18)
                .ignoresSafeArea()

            GlassCard(padding: 30, tint: Color.white.opacity(0.78)) {
                VStack(alignment: .leading, spacing: 26) {
                    HStack(alignment: .top, spacing: 20) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("SunCodexClaw Studio")
                                .font(.system(size: 40, weight: .bold, design: .rounded))
                            Text("把机器人运行时直接带进 App。第一次安装后，用户只需要按引导新建机器人、填写配置、校验并手动启动。")
                                .font(.system(.title3, design: .rounded))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Spacer()

                        VStack(alignment: .trailing, spacing: 8) {
                            DetailChip(label: store.hasAccounts ? "已有 \(store.summary?.accounts.count ?? 0) 个 Studio 机器人" : "准备创建第一个机器人")
                            if let runtime = store.runtime {
                                DetailChip(label: runtime.bundleVersion, accent: .green)
                            }
                        }
                    }

                    HStack(spacing: 14) {
                        WelcomeFactCard(
                            icon: "shippingbox.fill",
                            title: "内置运行时",
                            detail: "模板会安装到 Application Support，后面直接由 App 自己读写配置、日志和脚本。"
                        )
                        WelcomeFactCard(
                            icon: "lock.shield.fill",
                            title: "不接管当前仓库",
                            detail: "Studio 用独立 launchctl 前缀运行，不会碰你现在仓库里已经启动的机器人。"
                        )
                        WelcomeFactCard(
                            icon: "play.square.stack.fill",
                            title: "创建后手动启动",
                            detail: "保存配置不会自动启动。先 dry-run，再决定什么时候把新机器人跑起来。"
                        )
                    }

                    if let health = store.environmentHealth {
                        GlassCard(padding: 18, tint: health.ok ? Color.green.opacity(0.10) : Color.orange.opacity(0.12)) {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    MonitorStatusLight(state: health.ok ? "healthy" : "error", label: health.summary)
                                    Spacer()
                                    Button {
                                        Task { await store.refreshEnvironmentHealth() }
                                    } label: {
                                        Label("重新检测", systemImage: "arrow.triangle.2.circlepath")
                                    }
                                    .buttonStyle(.bordered)
                                }
                                WelcomeHealthRow(title: "CLI", check: health.binary)
                                WelcomeHealthRow(title: "登录态", check: health.login)
                                WelcomeHealthRow(title: "连通性", check: health.connectivity)
                            }
                        }
                    }

                    GlassCard(padding: 18, tint: Color(red: 0.95, green: 0.97, blue: 1.0)) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("首次安装怎么用")
                                .font(.system(.title3, design: .rounded).weight(.semibold))

                            GuideStep(index: 1, title: "点“创建第一个机器人”", detail: "先建立一个 Studio 专属账号名，后续配置、日志和运行状态都会按这个账号聚合。")
                            GuideStep(index: 2, title: "填飞书接入和工作目录", detail: "至少填 App ID、App Secret、Encrypt Key、Verification Token、机器人名称和 Codex 工作目录。")
                            GuideStep(index: 3, title: "先做校验，再决定是否启动", detail: "dry-run 只验证配置；如果你要接管已有飞书机器人，先停掉仓库版，避免重复响应。")
                        }
                    }

                    if let runtime = store.runtime {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Studio 安装位置")
                                .font(.system(.headline, design: .rounded))
                            Text(runtime.rootURL.path)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                            Text("launchctl 前缀：\(runtime.launchctlPrefix)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }

                    HStack {
                        Button {
                            store.dismissOnboarding()
                        } label: {
                            Label("先看工作台", systemImage: "rectangle.split.2x1")
                        }
                        .buttonStyle(.bordered)

                        Spacer()

                        Button {
                            store.dismissOnboarding(openRobotCreator: true)
                        } label: {
                            Label("创建第一个机器人", systemImage: "plus.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!store.canCreateBots)
                    }
                }
            }
            .frame(maxWidth: 1020)
            .padding(28)
        }
    }
}

private struct WelcomeFactCard: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(title)
                .font(.system(.headline, design: .rounded))
            Text(detail)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct WelcomeHealthRow: View {
    let title: String
    let check: EnvironmentCheck

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusBullet(passed: check.passed)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(title) · \(check.label)")
                    .font(.system(.body, design: .rounded).weight(.semibold))
                Text(check.detail)
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct MonitorStatusLight: View {
    let state: String
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            Text(label)
                .font(.system(.caption, design: .rounded).weight(.semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(color.opacity(0.12), in: Capsule())
    }

    private var color: Color {
        switch state {
        case "healthy", "running": return .green
        case "warning", "busy": return .orange
        case "checking": return .blue
        case "error": return .red
        default: return .secondary
        }
    }
}

private struct StatusBullet: View {
    let passed: Bool

    var body: some View {
        Circle()
            .fill(passed ? Color.green : Color.orange)
            .frame(width: 10, height: 10)
    }
}

private struct MonitorDot: View {
    let state: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
    }

    private var color: Color {
        switch state {
        case "running", "healthy": return .green
        case "busy", "checking": return .blue
        case "warning": return .orange
        case "error", "stopped": return .red
        default: return .secondary
        }
    }
}

private struct InlineRunButton: View {
    let isRunning: Bool
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(isRunning ? "关闭" : "开启", systemImage: isRunning ? "power.circle.fill" : "power.circle")
        }
        .buttonStyle(.borderless)
        .disabled(isBusy)
    }
}

private struct GlassCard<Content: View>: View {
    var padding: CGFloat = 18
    var tint: Color = Color.white.opacity(0.58)
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(tint)
                    .overlay(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(Color.white.opacity(0.58), lineWidth: 1)
                    )
            )
            .shadow(color: Color.black.opacity(0.08), radius: 24, x: 0, y: 12)
    }
}

private struct StatusBadge: View {
    let state: String

    var body: some View {
        Text(label)
            .font(.system(.caption, design: .rounded).weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch state {
        case "running": return "运行中"
        case "busy": return "执行中"
        case "warning": return "告警"
        case "stopped": return "已停止"
        default: return state
        }
    }

    private var color: Color {
        switch state {
        case "running": return .green
        case "busy": return .blue
        case "warning": return .orange
        case "stopped": return .secondary
        default: return .secondary
        }
    }
}

private struct DetailChip: View {
    let label: String
    var accent: Color = .accentColor

    var body: some View {
        Text(label)
            .font(.system(.caption, design: .rounded))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(accent.opacity(0.10), in: Capsule())
            .foregroundStyle(accent)
            .lineLimit(1)
    }
}

private struct RuntimeStatCard: View {
    let title: String
    let value: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.headline, design: .rounded))
                .lineLimit(2)
            Text(subtitle)
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.64), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct ActionButton: View {
    let title: String
    let systemImage: String
    let role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.borderedProminent)
        .tint(role == .destructive ? .red : .accentColor)
    }
}

private struct GuideStep: View {
    let index: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(index)")
                .font(.system(.headline, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Color.accentColor, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(.body, design: .rounded).weight(.semibold))
                Text(detail)
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

private struct LabeledField: View {
    let title: String
    @Binding var text: String
    var secure: Bool = false
    var onChange: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            if secure {
                SecureField(title, text: $text)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color.white.opacity(0.76), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .onChange(of: text) { _, _ in onChange?() }
            } else {
                TextField(title, text: $text)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color.white.opacity(0.76), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .onChange(of: text) { _, _ in onChange?() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NumericField: View {
    let title: String
    @Binding var value: Int
    var onChange: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            TextField(title, value: $value, format: .number)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color.white.opacity(0.76), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .onChange(of: value) { _, _ in onChange?() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PathField: View {
    let title: String
    @Binding var text: String
    let browse: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                TextField(title, text: $text)
                    .textFieldStyle(.plain)
                    .font(.system(.body, design: .monospaced))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color.white.opacity(0.76), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                Button("浏览", action: browse)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ToggleRow: View {
    let title: String
    @Binding var isOn: Bool
    var onChange: (() -> Void)? = nil

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title)
                .font(.system(.body, design: .rounded))
        }
        .toggleStyle(.switch)
        .onChange(of: isOn) { _, _ in onChange?() }
    }
}

private struct BannerView: View {
    let banner: BannerMessage

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
            Text(banner.text)
                .lineLimit(3)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(color.opacity(0.94), in: Capsule())
        .foregroundStyle(.white)
        .shadow(color: Color.black.opacity(0.2), radius: 20, x: 0, y: 10)
    }

    private var color: Color {
        switch banner.tone {
        case .success: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }

    private var icon: String {
        switch banner.tone {
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }
}
