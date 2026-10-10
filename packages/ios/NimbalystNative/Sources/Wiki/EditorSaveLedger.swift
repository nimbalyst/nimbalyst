import Foundation

/// The last body native persisted for the open document, so the save an editor
/// sends as it is torn down (no revision, no ack to wait for) is skipped when
/// it is only the text native already wrote. Without this, a remote version
/// that persisted after our save, but before the bundle heard the ack, would
/// be overwritten by our own older text. Genuinely unsaved text still wins
/// (last write wins).
struct EditorSaveLedger {
    private(set) var lastPersistedBody: String?

    /// Content loaded into the editor, or a remote version applied or deferred:
    /// either way it is what the local cache holds.
    mutating func loaded(_ content: String) { lastPersistedBody = content }

    mutating func persisted(_ content: String) { lastPersistedBody = content }

    /// Saves with a revision always go through (the bundle needs their ack).
    func shouldPersist(_ content: String, revision: Int?) -> Bool {
        revision != nil || content != lastPersistedBody
    }
}
