#if canImport(UIKit)
import UIKit
import WebKit

extension AppState {
    /// The account selection Pages runs under: the signed-in account at the
    /// current generation, or a fixed fixture selection in screenshot mode.
    func pagesAccount() -> ConsoleAccountContext? {
        #if DEBUG
        if screenshotMode {
            return ConsoleAccountContext(accountId: "screenshot", apiBase: URL(string: "https://sync.invalid")!, generation: consoleGeneration)
        }
        #endif
        return currentConsoleAccount()
    }

    /// The Pages web controller, only if it belongs to the current selection.
    /// Never creates one, so a view body may call it.
    func currentPagesController() -> PagesWebController? {
        guard let controller = pagesWebController, let account = pagesAccount(), controller.account == account else { return nil }
        return controller
    }

    /// Network reachability shared by Pages and the Team tab.
    func pagesReachability() -> ConsoleReachability {
        if let existing = consoleReachability { return existing }
        let reachability = ConsoleReachability()
        consoleReachability = reachability
        return reachability
    }

    /// Create the controller for the current selection. A store whose removal
    /// is still pending from a sign-out is removed first; until that succeeds
    /// Pages does not open on it (`pagesStoreBlocked`).
    func preparePagesController() async {
        guard currentPagesController() == nil, let broker = consoleBroker, let account = pagesAccount() else { return }
        if !screenshotMode {
            let ready = await broker.prepareStore(forAccount: account.accountId)
            guard pagesAccount() == account, currentPagesController() == nil else { return }
            if !ready {
                pagesStoreBlocked = true
                objectWillChange.send()
                return
            }
        }
        pagesStoreBlocked = false
        pagesWebController?.tearDown()
        if !screenshotMode { broker.noteStoreCreated(forAccount: account.accountId) }

        let reachability = pagesReachability()
        let dataStore = screenshotMode
            ? WKWebsiteDataStore.nonPersistent()
            : WKWebsiteDataStore(forIdentifier: ConsoleSessionBroker.dataStoreIdentifier(forAccount: account.accountId))
        pagesWebController = PagesWebController(
            environment: consoleEnvironment,
            account: account,
            broker: broker,
            dataStore: dataStore,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            flush: PagesFlushCoordinator(backgroundTasks: UIKitBackgroundTasks()),
            isOnline: { reachability.isOnline },
            hooks: PagesWebController.Hooks(
                openExternally: { UIApplication.shared.open($0) },
                appRoute: { [weak self] route in
                    switch route {
                    case .session(let id): NotificationManager.shared.pendingSessionId = id
                    case .openPairingScanner: self?.pairingScannerRequested = true
                    case .console(let route): ConsoleLinkInbox.shared.open(route)
                    case .consolePersonal, .authCallback, .unsupported: break
                    }
                }
            )
        )
        objectWillChange.send()
    }

    #if DEBUG
    /// `--console-pages-fixture[=<origin>]`: map every project to a fixture team
    /// and point the console at `<origin>` (a local fixture server in UI tests;
    /// unreachable by default, which shows the error state).
    func applyConsolePagesFixture(arguments: [String] = CommandLine.arguments) {
        guard let argument = arguments.first(where: { $0.hasPrefix("--console-pages-fixture") }) else { return }
        consolePagesFixtureMatch = ConsoleTeamProjectMatch(orgId: "organization-fixture", orgName: "Fixture Team", teamProjectId: "fixture-project")
        let origin = argument.split(separator: "=", maxSplits: 1).dropFirst().first.map(String.init) ?? "https://console.invalid"
        if let url = URL(string: origin) { consoleEnvironment = ConsoleEnvironment(origin: url) }
    }
    #endif
}
#endif
