import SwiftUI

@main
struct SunCodexClawStudioApp: App {
    @StateObject private var store = StudioStore()

    var body: some Scene {
        WindowGroup("SunCodexClaw Studio") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 1280, minHeight: 860)
                .onAppear {
                    store.start()
                }
        }
        .defaultSize(width: 1460, height: 940)
        .windowResizability(.contentMinSize)
    }
}
