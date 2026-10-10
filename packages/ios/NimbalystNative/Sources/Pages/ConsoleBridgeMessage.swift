import Foundation

/// The message handler name the console posts to. Sent in the embed marker.
public let consoleBridgeHandlerName = "nimbalystConsole"

/// Outcome of the console's `flushPending`.
public struct ConsoleFlushResult: Equatable, Sendable {
    public enum Status: String, Sendable {
        case acknowledged
        case notRequired = "not-required"
        case timedOut = "timed-out"
        case failed
    }

    public let status: Status
    public let detail: String?

    public init(status: Status, detail: String? = nil) {
        self.status = status
        self.detail = detail
    }

    /// Parse the object `flushPending` resolves with. Anything else is a failure.
    public static func parse(_ value: Any?) -> ConsoleFlushResult {
        guard let record = value as? [String: Any],
              let raw = record["status"] as? String,
              let status = Status(rawValue: raw) else {
            return ConsoleFlushResult(status: .failed, detail: "malformed-flush-result")
        }
        return ConsoleFlushResult(status: status, detail: record["detail"] as? String)
    }
}

/// Console -> native messages (`web-console/src/embedded/bridge.ts`).
/// Tokens never travel in this direction; anything malformed is dropped.
public enum ConsoleBridgeMessage: Equatable, Sendable {
    /// Posted by native's own document-start script (not the console): the
    /// per-document nonce a session delivery must match.
    case documentStart(nonce: String)
    case ready(protocolVersion: Int)
    case route(path: String, title: String, canGoBack: Bool)
    case editState(editing: Bool, unsynced: Bool)
    case requestSession(requestId: String, orgId: String)
    case sessionExpired(requestId: String, orgId: String?)
    case orgAuthRequired(orgId: String, reason: String?)
    case openExternal(URL)
    case openPersonal(path: String)
    case flushResult(requestId: String, result: ConsoleFlushResult)

    public static func parse(_ body: Any) -> ConsoleBridgeMessage? {
        guard let record = body as? [String: Any], let type = record["type"] as? String else { return nil }
        func string(_ key: String, max: Int = 2048) -> String? {
            guard let value = record[key] as? String, !value.isEmpty, value.count <= max else { return nil }
            return value
        }
        switch type {
        case "documentStart":
            guard let nonce = string("nonce", max: 64), nonce.count == 32,
                  nonce.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
            return .documentStart(nonce: nonce)
        case "ready":
            return .ready(protocolVersion: (record["protocol"] as? NSNumber)?.intValue ?? 0)
        case "route":
            guard let path = string("path") else { return nil }
            let title = (record["title"] as? String).map { String($0.prefix(256)) } ?? ""
            return .route(path: path, title: title, canGoBack: (record["canGoBack"] as? Bool) ?? false)
        case "editState":
            return .editState(editing: (record["editing"] as? Bool) ?? false, unsynced: (record["unsynced"] as? Bool) ?? false)
        case "requestSession":
            guard let requestId = string("requestId", max: 128), let orgId = string("orgId", max: 128) else { return nil }
            return .requestSession(requestId: requestId, orgId: orgId)
        case "sessionExpired":
            guard let requestId = string("requestId", max: 128) else { return nil }
            return .sessionExpired(requestId: requestId, orgId: string("orgId", max: 128))
        case "orgAuthRequired":
            guard let orgId = string("orgId", max: 128) else { return nil }
            return .orgAuthRequired(orgId: orgId, reason: string("reason", max: 128))
        case "openExternal":
            guard let raw = string("url"), let url = URL(string: raw) else { return nil }
            return .openExternal(url)
        case "openPersonal":
            guard let path = string("path") else { return nil }
            return .openPersonal(path: path)
        case "flushResult":
            guard let requestId = string("requestId", max: 128) else { return nil }
            return .flushResult(requestId: requestId, result: ConsoleFlushResult.parse(record))
        default:
            return nil
        }
    }
}

/// The document-start script that marks this page as hosted by the app.
/// It only sets the marker on the console origin, so a page that somehow
/// loads elsewhere in the main frame never sees a bridge name.
public func consoleEmbedMarkerScript(environment: ConsoleEnvironment, appVersion: String) -> String {
    let version = String(appVersion.prefix(64))
    let encodedVersion = (try? String(data: JSONSerialization.data(withJSONObject: [version]), encoding: .utf8))
        .flatMap { $0.dropFirst().dropLast().description } ?? "\"\""
    let origin = environment.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let encodedOrigin = (try? String(data: JSONSerialization.data(withJSONObject: [origin]), encoding: .utf8))
        .flatMap { $0.dropFirst().dropLast().description } ?? "\"\""
    // A fresh random nonce per document, fixed on `window` before any console
    // code runs and announced to native first. Delivery checks it in-page.
    return """
    (function () {
      if (window.location.origin !== \(encodedOrigin)) return;
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      Object.defineProperty(window, '__nimbalystDocumentNonce', { value: nonce, configurable: false, writable: false });
      Object.defineProperty(window, '__NIMBALYST_EMBED__', {
        value: Object.freeze({ platform: 'ios', appVersion: \(encodedVersion), bridge: '\(consoleBridgeHandlerName)' }),
        configurable: false, writable: false
      });
      window.webkit.messageHandlers['\(consoleBridgeHandlerName)'].postMessage({ type: 'documentStart', nonce: nonce });
    })();
    """
}
