import Foundation

/// A frontmatter, sidecar or table cell value as the local wiki library reads
/// it (YAML core schema, or a decoded CSV cell). Decodes from the JSON in the
/// shared fixtures, so tests compare like with like.
public indirect enum WikiValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([WikiValue])
    case object([String: WikiValue])

    /// Short read-only rendering for field rows and table cells.
    public var displayText: String {
        switch self {
        case .null: return ""
        case .bool(let value): return value ? "Yes" : "No"
        case .number(let value): return WikiValue.formatNumber(value)
        case .string(let value): return value
        case .array(let items): return items.map(\.displayText).joined(separator: ", ")
        case .object(let map):
            return map.keys.sorted().map { "\($0): \(map[$0]!.displayText)" }.joined(separator: ", ")
        }
    }

    /// `String(n)` in JavaScript: integers without a decimal point.
    static func formatNumber(_ value: Double) -> String {
        if value.isFinite, value == value.rounded(), abs(value) < 1e15 {
            return String(Int64(value))
        }
        return String(value)
    }

    init(json: Any) {
        switch json {
        case is NSNull: self = .null
        case let number as NSNumber:
            // JSONSerialization returns booleans as NSNumber too.
            if CFGetTypeID(number) == CFBooleanGetTypeID() { self = .bool(number.boolValue) }
            else { self = .number(number.doubleValue) }
        case let string as String: self = .string(string)
        case let array as [Any]: self = .array(array.map(WikiValue.init(json:)))
        case let map as [String: Any]: self = .object(map.mapValues(WikiValue.init(json:)))
        default: self = .string(String(describing: json))
        }
    }
}

extension WikiValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([WikiValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: WikiValue].self)) }
    }
}

/// A named value, kept in the order the file wrote it.
public struct WikiField: Hashable, Sendable {
    public let name: String
    public let value: WikiValue
}

/// A YAML mapping with its key order.
public struct WikiMap: Hashable, Sendable {
    public private(set) var keys: [String] = []
    public private(set) var values: [String: WikiValue] = [:]

    public init() {}

    public subscript(key: String) -> WikiValue? { values[key] }

    /// False when the key was already present (YAML forbids duplicate keys).
    @discardableResult
    mutating func set(_ key: String, _ value: WikiValue) -> Bool {
        if values[key] != nil { return false }
        keys.append(key)
        values[key] = value
        return true
    }

    var fields: [WikiField] { keys.map { WikiField(name: $0, value: values[$0]!) } }
    var asValue: WikiValue { .object(values) }
}
