// MARK: - Lock-free SPSC Ring Buffer

/// Single-producer single-consumer ring buffer for real-time audio playback.
/// Producer (main thread) writes 48kHz PCM16 via `write()`.
/// Consumer (audio thread) reads via `read()`, filling remainder with silence.
///
/// Thread safety: Each index is written by exactly one thread and read by the other (SPSC pattern).
/// On ARM64, naturally-aligned word loads/stores are atomic, which is sufficient for SPSC.
///
/// Defined outside the `#if os(iOS)` audio code (it has no platform dependencies)
/// so this concurrency-sensitive component can be unit tested on macOS.
nonisolated final class PlaybackRingBuffer: @unchecked Sendable {
    private let storage: UnsafeMutablePointer<Int16>
    private let capacity: Int

    nonisolated(unsafe) private var writePos: Int = 0
    nonisolated(unsafe) private var readPos: Int = 0

    init(capacity: Int) {
        self.capacity = capacity
        self.storage = .allocate(capacity: capacity)
        self.storage.initialize(repeating: 0, count: capacity)
    }

    deinit { storage.deallocate() }

    var availableFrames: Int {
        let w = writePos, r = readPos
        return w >= r ? w - r : capacity - r + w
    }

    /// Write frames. Returns number actually written.
    func write(_ src: UnsafePointer<Int16>, count: Int) -> Int {
        let r = readPos, w = writePos
        let free = r > w ? r - w - 1 : capacity - w + r - 1
        let n = min(count, free)
        guard n > 0 else { return 0 }

        let first = min(n, capacity - w)
        storage.advanced(by: w).update(from: src, count: first)
        if n > first {
            storage.update(from: src.advanced(by: first), count: n - first)
        }
        writePos = (w + n) % capacity
        return n
    }

    /// Read frames into dst. Fills any shortfall with silence. Returns frames of real data read.
    func read(_ dst: UnsafeMutablePointer<Int16>, count: Int) -> Int {
        let w = writePos, r = readPos
        let avail = w >= r ? w - r : capacity - r + w
        let n = min(count, avail)

        if n > 0 {
            let first = min(n, capacity - r)
            dst.update(from: storage.advanced(by: r), count: first)
            if n > first {
                dst.advanced(by: first).update(from: storage, count: n - first)
            }
            readPos = (r + n) % capacity
        }

        // Fill remainder with silence
        if n < count {
            dst.advanced(by: n).initialize(repeating: 0, count: count - n)
        }

        return n
    }

    func reset() {
        readPos = 0
        writePos = 0
    }

    /// Apply a short linear fade-out to the buffered audio and discard the rest.
    /// Used on barge-in so playback ramps to silence instead of cutting abruptly
    /// (a hard reset() leaves a non-zero sample next to silence -> audible click).
    /// Producer-thread only. The faded tail overlaps frames the consumer may be
    /// reading concurrently, but each Int16 store is atomic on ARM64, so the
    /// worst case is a few samples read pre/post-fade -- inaudible over ~10ms.
    func fadeOutAndTruncate(fadeFrames: Int) {
        let r = readPos, w = writePos
        let avail = w >= r ? w - r : capacity - r + w
        guard avail > 0, fadeFrames > 0 else { reset(); return }
        let n = min(fadeFrames, avail)
        for i in 0..<n {
            let idx = (r + i) % capacity
            let gain = Double(n - 1 - i) / Double(n) // 1.0 -> 0.0
            storage[idx] = Int16(Double(storage[idx]) * gain)
        }
        // Keep only the faded tail; drop everything after it. Guard against a
        // fast consumer: only move writePos back if the consumer is still inside
        // the faded tail, otherwise a backwards writePos makes availableFrames
        // wrap to a bogus near-capacity value.
        let intendedWrite = (r + n) % capacity
        let rNow = readPos
        let stillBuffered = intendedWrite >= rNow ? intendedWrite - rNow : capacity - rNow + intendedWrite
        if stillBuffered <= n {
            writePos = intendedWrite
        }
    }
}
