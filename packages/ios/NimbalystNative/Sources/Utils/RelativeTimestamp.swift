import Foundation

/// Formats epoch millisecond timestamps into relative human-readable strings.
public enum RelativeTimestamp {
    /// Format an epoch millisecond timestamp into a relative string like "2m ago", "3h ago".
    public static func format(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000.0)
        let now = Date()
        let seconds = Int(now.timeIntervalSince(date))

        if seconds < 0 {
            return "now"
        } else if seconds < 60 {
            return "now"
        } else if seconds < 3600 {
            let minutes = seconds / 60
            return "\(minutes)m ago"
        } else if seconds < 86400 {
            let hours = seconds / 3600
            return "\(hours)h ago"
        } else if seconds < 604800 {
            let days = seconds / 86400
            return "\(days)d ago"
        } else {
            let formatter = DateFormatter()
            formatter.dateStyle = .short
            formatter.timeStyle = .none
            return formatter.string(from: date)
        }
    }
}
