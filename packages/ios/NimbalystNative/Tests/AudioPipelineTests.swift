import XCTest
@testable import NimbalystNative

/// Tests for the voice audio pipeline encoding format.
/// The standalone macOS test (test-realtime-audio.swift) confirmed
/// that our PCM16 24kHz format is correct -- OpenAI responds "I hear a tone."
final class AudioPipelineTests: XCTestCase {

    func testSineWaveGeneratesPCM16WithCorrectPeak() {
        let sampleRate: Double = 24000
        let frequency: Double = 440
        let frameCount = Int(sampleRate * 0.1) // 100ms = 2400 frames
        var pcm16 = Data(count: frameCount * 2)
        pcm16.withUnsafeMutableBytes { raw in
            let ptr = raw.bindMemory(to: Int16.self)
            for i in 0..<frameCount {
                let t = Double(i) / sampleRate
                let sample = sin(2.0 * .pi * frequency * t)
                let clamped = max(-1.0, min(1.0, sample))
                ptr[i] = clamped < 0 ? Int16(clamped * 32768.0) : Int16(clamped * 32767.0)
            }
        }

        XCTAssertEqual(pcm16.count, 4800)

        var peak: Int16 = 0
        pcm16.withUnsafeBytes { raw in
            let ptr = raw.bindMemory(to: Int16.self)
            for i in 0..<frameCount {
                let v = ptr[i] == Int16.min ? Int16.max : (ptr[i] < 0 ? -ptr[i] : ptr[i])
                if v > peak { peak = v }
            }
        }
        XCTAssertGreaterThan(peak, 30000)
    }

    func testBase64EncodingSize() {
        let pcm16 = Data(repeating: 0, count: 4800) // 100ms at 24kHz
        let base64 = pcm16.base64EncodedString()
        XCTAssertEqual(base64.count, 6400) // ceil(4800/3)*4
    }

    func testPCM16IsLittleEndian() {
        let value: Int16 = 0x0102
        var data = Data(count: 2)
        data.withUnsafeMutableBytes { raw in
            raw.bindMemory(to: Int16.self)[0] = value
        }
        XCTAssertEqual(data[0], 0x02) // low byte first
        XCTAssertEqual(data[1], 0x01)
    }

    /// Barge-in fade: the playback buffer must ramp to silence and discard the
    /// rest, so an interrupt doesn't cut off with an audible click (and stale
    /// audio past the fade tail doesn't keep playing).
    func testFadeOutRampsToSilenceAndTruncates() {
        let rb = PlaybackRingBuffer(capacity: 4800)
        var samples = [Int16](repeating: 10000, count: 1000)
        let written = samples.withUnsafeBufferPointer { rb.write($0.baseAddress!, count: 1000) }
        XCTAssertEqual(written, 1000)
        XCTAssertEqual(rb.availableFrames, 1000)

        rb.fadeOutAndTruncate(fadeFrames: 480)
        // Everything past the faded tail is dropped.
        XCTAssertEqual(rb.availableFrames, 480)

        var out = [Int16](repeating: 0, count: 480)
        let read = out.withUnsafeMutableBufferPointer { rb.read($0.baseAddress!, count: 480) }
        XCTAssertEqual(read, 480)
        // Starts near full scale, ends at exactly zero (no click), monotonic down.
        XCTAssertGreaterThan(out[0], 9000)
        XCTAssertEqual(out[479], 0)
        for i in 1..<480 { XCTAssertLessThanOrEqual(out[i], out[i - 1]) }
    }

    /// Fading an empty buffer is a no-op (no crash, nothing to play).
    func testFadeOutEmptyBufferIsSafe() {
        let rb = PlaybackRingBuffer(capacity: 4800)
        rb.fadeOutAndTruncate(fadeFrames: 480)
        XCTAssertEqual(rb.availableFrames, 0)
    }

    func testDownsample48kTo24k() {
        let srcFrames = 480
        var srcData = Data(count: srcFrames * 2)
        srcData.withUnsafeMutableBytes { raw in
            let ptr = raw.bindMemory(to: Int16.self)
            for i in 0..<srcFrames { ptr[i] = Int16(i) }
        }

        let outFrames = srcFrames / 2
        var downsampled = Data(count: outFrames * 2)
        srcData.withUnsafeBytes { srcRaw in
            let src = srcRaw.bindMemory(to: Int16.self)
            downsampled.withUnsafeMutableBytes { dstRaw in
                let dst = dstRaw.bindMemory(to: Int16.self)
                for i in 0..<outFrames { dst[i] = src[i * 2] }
            }
        }

        XCTAssertEqual(downsampled.count, 480)
        downsampled.withUnsafeBytes { raw in
            let ptr = raw.bindMemory(to: Int16.self)
            XCTAssertEqual(ptr[0], 0)
            XCTAssertEqual(ptr[1], 2)
            XCTAssertEqual(ptr[2], 4)
        }
    }
}
