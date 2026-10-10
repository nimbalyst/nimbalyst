import Foundation
import Combine

/// The one channel every inbound console link takes to the Pages screen:
/// universal links, `nimbalyst://console/...`, transcript links, and (later)
/// a push's `consolePath`.
///
/// `pending` holds a link that arrived before any navigation view was there to
/// take it (cold launch, signed out). A mounted view subscribes to `routes`,
/// acts on the value it was handed, and then calls `acknowledge(_:)`. It never
/// re-reads `pending` inside the handler: `@Published` emits in `willSet`, so
/// the property still holds the previous value at that moment.
@MainActor
public final class ConsoleLinkInbox: ObservableObject {
    public static let shared = ConsoleLinkInbox()

    @Published public private(set) var pending: ConsoleRoute?
    /// Set when a link named a Personal page, which only the desktop holds.
    @Published public var personalPageRequested = false

    private let environment: ConsoleEnvironment

    public init(environment: ConsoleEnvironment = .production) {
        self.environment = environment
    }

    /// Each route as it arrives, including one already pending when subscribed.
    public var routes: AnyPublisher<ConsoleRoute, Never> {
        $pending.compactMap { $0 }.eraseToAnyPublisher()
    }

    /// The team route an https console URL or `nimbalyst://console/...` link names, if any.
    public func teamRoute(for url: URL) -> ConsoleRoute? {
        if environment.isConsoleOrigin(url) {
            guard let route = ConsoleRoute(url: url, environment: environment), route.isTeamProjectPath else { return nil }
            return route
        }
        if case .console(let route) = NimbalystExternalURLRouter.route(url) { return route }
        return nil
    }

    /// Route a link to Pages when it is a console team page. Returns false for
    /// anything else, so the caller falls back to its existing handling.
    @discardableResult
    public func open(_ url: URL) -> Bool {
        guard let route = teamRoute(for: url) else { return false }
        open(route)
        return true
    }

    public func open(_ route: ConsoleRoute) {
        pending = route
    }

    /// A push's reserved `consolePath` key. Nothing sends it yet; when the
    /// server does, it lands here and nowhere else.
    @discardableResult
    public func open(path: String) -> Bool {
        guard let route = ConsoleRoute(path: path), route.isTeamProjectPath else { return false }
        open(route)
        return true
    }

    /// The handler has acted on `route`. Clears it unless a newer link already
    /// replaced it. Deferred a turn: the handler runs inside `willSet`, before
    /// `pending` holds `route`, so clearing synchronously would miss it and a
    /// later subscriber would replay the stale link.
    public func acknowledge(_ route: ConsoleRoute) {
        Task { @MainActor [weak self] in
            guard let self, self.pending == route else { return }
            self.pending = nil
        }
    }
}
