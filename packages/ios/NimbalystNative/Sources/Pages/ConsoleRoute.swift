import Foundation

/// Where the team console is served. Production is fixed; tests point it at a
/// fixture origin. Only this origin may load in the Pages web view's main frame
/// or talk to the native bridge.
public struct ConsoleEnvironment: Equatable, Sendable {
    public static let production = ConsoleEnvironment(origin: URL(string: "https://console.nimbalyst.com")!)

    /// Scheme, host and (optional) port. No path.
    public let origin: URL

    public init(origin: URL) {
        self.origin = origin
    }

    /// `window.location.origin` form: scheme://host[:port], no trailing slash.
    public var originString: String {
        origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    public var scheme: String { origin.scheme?.lowercased() ?? "https" }
    public var host: String { origin.host?.lowercased() ?? "" }
    public var port: Int? { origin.port }

    /// True when `url` is on exactly this origin (scheme, host, port).
    public func isConsoleOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == host
            && effectivePort(url.port, scheme: url.scheme) == effectivePort(port, scheme: scheme)
    }

    /// True for a WebKit security origin triple on this origin.
    public func isConsoleOrigin(protocol scheme: String, host: String, port: Int) -> Bool {
        scheme.lowercased() == self.scheme
            && host.lowercased() == self.host
            && effectivePort(port == 0 ? nil : port, scheme: scheme) == effectivePort(self.port, scheme: self.scheme)
    }

    /// The absolute console URL for a route path (`/org/...`, with query and fragment).
    public func url(for path: String) -> URL? {
        guard path.hasPrefix("/") else { return nil }
        return URL(string: origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)
    }

    private func effectivePort(_ port: Int?, scheme: String?) -> Int {
        if let port { return port }
        return scheme?.lowercased() == "http" ? 80 : 443
    }
}

/// A console page the Pages screen can show: a path under `/org/<org>/`.
///
/// The org segment is a route key: today always the Stytch org id
/// (`organization-...`), and possibly a slug in the future. `orgId` is only set
/// when the key is an org id, matching the console's own `orgIdFromConsolePath`.
public struct ConsoleRoute: Hashable, Sendable {
    /// Path plus query and fragment, percent-encoded as it appears in the URL.
    public let path: String
    public let orgKey: String
    /// The team project segment, when the path is under `/project/<id>`.
    public let teamProjectId: String?

    public var orgId: String? { orgKey.hasPrefix("organization-") ? orgKey : nil }
    public var isTeamProjectPath: Bool { teamProjectId != nil }

    private static let orgKeyCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    private static let segmentCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.~%")

    /// Parse a console path (`/org/<org>/...`, optional `?query` and `#fragment`).
    /// Rejects traversal, empty segments, control characters and anything that
    /// is not under `/org/<key>`.
    public init?(path: String) {
        guard path.count <= 2048, path.hasPrefix("/org/") else { return nil }
        guard !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == " " || $0 == "\\" }) else { return nil }
        let pathOnly = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
            .split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let segments = pathOnly.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        // Leading "/" yields an empty first element, dropped above. Every other
        // segment must be non-empty except a single trailing slash.
        var parts = Array(segments)
        if parts.last == "" { parts.removeLast() }
        guard parts.count >= 2, parts[0] == "org", !parts.contains("") else { return nil }
        let orgKey = String(parts[1])
        guard (1...128).contains(orgKey.count),
              orgKey.unicodeScalars.allSatisfy(Self.orgKeyCharacters.contains) else { return nil }
        // Judge each segment by what it decodes to: `.%2e` is `..` to the server
        // that normalizes it, and an encoded `/` or `\` splits the path there.
        var decoded: [String] = []
        for part in parts.dropFirst(2) {
            guard part.count <= 256, part.unicodeScalars.allSatisfy(Self.segmentCharacters.contains),
                  let segment = Self.decodeSegment(String(part)),
                  segment != ".", segment != "..",
                  !segment.unicodeScalars.contains(where: { $0 == "/" || $0 == "\\" || CharacterSet.controlCharacters.contains($0) })
            else { return nil }
            decoded.append(segment)
        }
        let teamProjectId: String? = parts.count >= 4 && parts[2] == "project" ? decoded[1] : nil
        self.path = path
        self.orgKey = orgKey
        self.teamProjectId = teamProjectId
    }

    /// The route for an absolute console URL on `environment`'s origin.
    public init?(url: URL, environment: ConsoleEnvironment = .production) {
        guard environment.isConsoleOrigin(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var path = components.percentEncodedPath
        if let query = components.percentEncodedQuery { path += "?\(query)" }
        if let fragment = components.percentEncodedFragment { path += "#\(fragment)" }
        self.init(path: path)
    }

    /// The path a server sees after percent-decoding and removing dot segments
    /// (RFC 3986 5.2.4). Classification (`/app`, `/login`, ...) reads this, never
    /// the raw path, so `/org/o/.%2e/.%2e/app` is a Personal page, not a team one.
    public static func canonicalPath(_ rawPath: String) -> String {
        var output: [String] = []
        for raw in rawPath.split(separator: "/", omittingEmptySubsequences: false).dropFirst() {
            let segment = decodeSegment(String(raw)) ?? String(raw)
            switch segment {
            case ".": continue
            case "..": _ = output.popLast()
            default: output.append(segment)
            }
        }
        return "/" + output.joined(separator: "/")
    }

    /// Strict percent-decoding (UTF-8). Nil for a malformed escape or invalid UTF-8.
    static func decodeSegment(_ raw: String) -> String? {
        guard raw.contains("%") else { return raw }
        func hex(_ byte: UInt8) -> UInt8? {
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
            case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
            default: return nil
            }
        }
        let input = Array(raw.utf8)
        var bytes: [UInt8] = []
        var index = 0
        while index < input.count {
            if input[index] == UInt8(ascii: "%") {
                guard index + 2 < input.count, let high = hex(input[index + 1]), let low = hex(input[index + 2]) else { return nil }
                bytes.append(high << 4 | low)
                index += 3
            } else {
                bytes.append(input[index])
                index += 1
            }
        }
        return String(bytes: bytes, encoding: .utf8)
    }

    /// The team Wiki home for a project.
    public static func wiki(orgId: String, teamProjectId: String) -> ConsoleRoute? {
        ConsoleRoute(path: "/org/\(encode(orgId))/project/\(encode(teamProjectId))/wiki")
    }

    /// The team Trackers home for a project.
    public static func trackers(orgId: String, teamProjectId: String) -> ConsoleRoute? {
        ConsoleRoute(path: "/org/\(encode(orgId))/project/\(encode(teamProjectId))/trackers")
    }

    private static func encode(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.~")) ?? segment
    }
}
