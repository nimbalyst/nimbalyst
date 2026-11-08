// nimbalyst-dictation: on-device speech-to-text helper for Nimbalyst dictation.
//
// Protocol (one JSON object per line, both directions):
//
//   stdin  {"type":"start","id":"<dictationId>","locale":"en-US","contextualStrings":["foo"]}
//          {"type":"audio","id":"<dictationId>","data":"<base64 mono PCM16 LE @ 24kHz>"}
//          {"type":"stop","id":"<dictationId>","cancel":false}
//          {"type":"shutdown"}                         (EOF on stdin also shuts down)
//
//   stdout {"type":"hello","engine":"speech-analyzer"|"sf-speech","version":1}
//          {"type":"preparing","id":...}               (model assets downloading)
//          {"type":"ready","id":...}
//          {"type":"partial","id":...,"text":...}      (replaces the current partial)
//          {"type":"final","id":...,"text":...}        (commits a segment)
//          {"type":"error","id":...,"code":...,"message":...}
//          {"type":"ended","id":...}
//
// Audio is captured by the app (one microphone owner) and piped here; this
// process never opens an input device.
//
// `--probe` prints one JSON line describing the engine and authorization state
// and exits. `--legacy` forces the SFSpeechRecognizer path for testing.

import AVFoundation
import Foundation
import Speech

// MARK: - Output

let outputLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  outputLock.lock()
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
  outputLock.unlock()
}

struct HelperError: Error {
  let code: String
  let message: String
}

func emitError(_ id: String?, _ error: Error) {
  var payload: [String: Any] = ["type": "error"]
  if let id { payload["id"] = id }
  if let helperError = error as? HelperError {
    payload["code"] = helperError.code
    payload["message"] = helperError.message
  } else {
    payload["code"] = "engine-error"
    payload["message"] = String(describing: error)
  }
  emit(payload)
}

// MARK: - Audio

let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

func makeInputBuffer(_ data: Data) -> AVAudioPCMBuffer? {
  let frames = AVAudioFrameCount(data.count / 2)
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { return nil }
  buffer.frameLength = frames
  data.withUnsafeBytes { raw in
    let dst = buffer.int16ChannelData![0]
    raw.copyBytes(to: UnsafeMutableRawBufferPointer(start: dst, count: Int(frames) * 2))
  }
  return buffer
}

func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let ratio = format.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
  guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
  var consumed = false
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
    if consumed {
      inputStatus.pointee = .noDataNow
      return nil
    }
    consumed = true
    inputStatus.pointee = .haveData
    return buffer
  }
  if status == .error || output.frameLength == 0 { return nil }
  return output
}

// MARK: - Recognizers

protocol Recognizer: AnyObject {
  func append(_ data: Data)
  /// Resolves once every result for this dictation has been emitted.
  func stop(cancel: Bool) async
}

func cleanText(_ text: String) -> String {
  text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// SpeechAnalyzer ships in the macOS 26 SDK (Swift 6.2). Older toolchains build
// the SFSpeechRecognizer path only.
#if compiler(>=6.2)
@available(macOS 26, *)
func mapResults<S: AsyncSequence & Sendable>(
  _ sequence: S,
  _ transform: @escaping @Sendable (S.Element) -> (String, Bool)
) -> AsyncThrowingStream<(text: String, isFinal: Bool), Error> where S.Element: Sendable {
  AsyncThrowingStream { continuation in
    let task = Task {
      do {
        for try await element in sequence {
          let (text, isFinal) = transform(element)
          continuation.yield((text: text, isFinal: isFinal))
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
    continuation.onTermination = { _ in task.cancel() }
  }
}

@available(macOS 26, *)
final class AnalyzerRecognizer: Recognizer {
  private let id: String
  private var analyzer: SpeechAnalyzer?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?
  private var resultsTask: Task<Void, Never>?

  init(id: String) {
    self.id = id
  }

  func start(localeIdentifier: String?, contextualStrings: [String], variant: String) async throws {
    let requested = localeIdentifier.map { Locale(identifier: $0) } ?? Locale.current
    let useDictation = variant.hasPrefix("dictation")
    let supported = useDictation
      ? await DictationTranscriber.supportedLocale(equivalentTo: requested)
      : await SpeechTranscriber.supportedLocale(equivalentTo: requested)
    guard let locale = supported else {
      throw HelperError(code: "unsupported-locale", message: "On-device dictation does not support \(requested.identifier).")
    }

    // Variants exist to compare accuracy and latency on recorded audio
    // (temptests/dictation eval harness); the app sends the default.
    let module: any SpeechModule
    let results: AsyncThrowingStream<(text: String, isFinal: Bool), Error>
    switch variant {
    case "dictation", "dictation-long":
      let transcriber = DictationTranscriber(
        locale: locale,
        contentHints: variant == "dictation" ? [.shortForm] : [],
        transcriptionOptions: [.punctuation],
        reportingOptions: [.volatileResults, .frequentFinalization],
        attributeOptions: []
      )
      module = transcriber
      results = mapResults(transcriber.results) { (String($0.text.characters), $0.isFinal) }
    default:
      let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        // .fastResults: first text about 1.1s after speech instead of about 4s,
        // same accuracy on the eval corpus (2026-11-06). "speech-slow" keeps
        // the old behavior for comparison.
        reportingOptions: variant == "speech-slow" ? [.volatileResults] : [.volatileResults, .fastResults],
        attributeOptions: []
      )
      module = transcriber
      results = mapResults(transcriber.results) { (String($0.text.characters), $0.isFinal) }
    }

    let status = await AssetInventory.status(forModules: [module])
    if status == .unsupported {
      throw HelperError(code: "unsupported-locale", message: "On-device dictation is not available for \(locale.identifier).")
    }
    if status != .installed {
      emit(["type": "preparing", "id": id])
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        try await request.downloadAndInstall()
      }
    }

    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
      throw HelperError(code: "engine-error", message: "No audio format is compatible with the speech model.")
    }
    analyzerFormat = format
    converter = AVAudioConverter(from: inputFormat, to: format)

    let analyzer = SpeechAnalyzer(modules: [module])
    self.analyzer = analyzer
    if !contextualStrings.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = contextualStrings
      try await analyzer.setContext(context)
    }
    try await analyzer.prepareToAnalyze(in: format)

    let id = self.id
    resultsTask = Task {
      do {
        for try await result in results {
          let text = cleanText(result.text)
          if result.isFinal {
            if !text.isEmpty { emit(["type": "final", "id": id, "text": text]) }
          } else {
            emit(["type": "partial", "id": id, "text": text])
          }
        }
      } catch is CancellationError {
      } catch {
        emitError(id, error)
      }
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.continuation = continuation
    try await analyzer.start(inputSequence: stream)
  }

  func append(_ data: Data) {
    guard let continuation, let converter, let analyzerFormat,
          let input = makeInputBuffer(data),
          let converted = convert(input, with: converter, to: analyzerFormat) else { return }
    continuation.yield(AnalyzerInput(buffer: converted))
  }

  func stop(cancel: Bool) async {
    continuation?.finish()
    continuation = nil
    guard let analyzer else { return }
    if cancel {
      await analyzer.cancelAndFinishNow()
      resultsTask?.cancel()
      return
    }
    do {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      emitError(id, error)
      await analyzer.cancelAndFinishNow()
    }
    await resultsTask?.value
  }
}

#endif

/// macOS 13-25: SFSpeechRecognizer forced on-device.
final class LegacyRecognizer: Recognizer {
  private let id: String
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var recognizer: SFSpeechRecognizer?
  private let floatFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
  private var converter: AVAudioConverter?
  private let finishedLock = NSLock()
  private var finished = false
  private var finishWaiters: [CheckedContinuation<Void, Never>] = []

  init(id: String) {
    self.id = id
  }

  func start(localeIdentifier: String?, contextualStrings: [String]) async throws {
    let status = await legacyAuthorization(requestIfNeeded: true)
    guard status == .authorized else {
      throw HelperError(code: "speech-permission-denied", message: "Speech recognition permission is required for on-device dictation.")
    }
    let locale = localeIdentifier.map { Locale(identifier: $0) } ?? Locale.current
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
      throw HelperError(code: "unsupported-locale", message: "On-device dictation does not support \(locale.identifier).")
    }
    self.recognizer = recognizer
    converter = AVAudioConverter(from: inputFormat, to: floatFormat)

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.contextualStrings = contextualStrings
    if #available(macOS 13, *) { request.addsPunctuation = true }
    self.request = request

    let id = self.id
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      if let result {
        let text = cleanText(result.bestTranscription.formattedString)
        if result.isFinal {
          if !text.isEmpty { emit(["type": "final", "id": id, "text": text]) }
          self?.markFinished()
          return
        }
        emit(["type": "partial", "id": id, "text": text])
      }
      if let error {
        let nsError = error as NSError
        // 1110 = no speech detected, 216/301 = cancelled. Neither is a failure.
        let benign = nsError.domain == "kAFAssistantErrorDomain" && [1110, 216, 301].contains(nsError.code)
        if !benign { emitError(id, HelperError(code: "engine-error", message: nsError.localizedDescription)) }
        self?.markFinished()
      }
    }
  }

  private func markFinished() {
    finishedLock.lock()
    finished = true
    let waiters = finishWaiters
    finishWaiters = []
    finishedLock.unlock()
    waiters.forEach { $0.resume() }
  }

  private func waitForFinish() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      finishedLock.lock()
      if finished {
        finishedLock.unlock()
        continuation.resume()
        return
      }
      finishWaiters.append(continuation)
      finishedLock.unlock()
    }
  }

  func append(_ data: Data) {
    guard let request, let converter, let input = makeInputBuffer(data),
          let converted = convert(input, with: converter, to: floatFormat) else { return }
    request.append(converted)
  }

  func stop(cancel: Bool) async {
    if cancel {
      task?.cancel()
      markFinished()
      return
    }
    request?.endAudio()
    // The recognizer sometimes never delivers a final after endAudio when no
    // speech was heard; bound the wait so the session always ends.
    let timeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      self?.task?.finish()
      self?.markFinished()
    }
    await waitForFinish()
    timeout.cancel()
  }
}

func legacyAuthorization(requestIfNeeded: Bool) async -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  guard current == .notDetermined, requestIfNeeded else { return current }
  return await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
  }
}

func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-determined"
  @unknown default: return "unknown"
  }
}

// MARK: - Command loop

let forceLegacy = CommandLine.arguments.contains("--legacy")

func useAnalyzer() -> Bool {
  if forceLegacy { return false }
  #if compiler(>=6.2)
  if #available(macOS 26, *) { return SpeechTranscriber.isAvailable }
  #endif
  return false
}

final class Controller {
  private var activeId: String?
  private var recognizer: Recognizer?

  func handle(_ line: String) async {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else {
      emit(["type": "error", "code": "bad-command", "message": "Unparseable command"])
      return
    }
    let id = object["id"] as? String
    switch type {
    case "start":
      guard let id else { return }
      await stopActive(cancel: true)
      let locale = object["locale"] as? String
      let strings = (object["contextualStrings"] as? [String]) ?? []
      let variant = (object["variant"] as? String) ?? "speech"
      await start(id: id, locale: locale, contextualStrings: strings, variant: variant)
    case "audio":
      guard let id, id == activeId, let base64 = object["data"] as? String,
            let bytes = Data(base64Encoded: base64) else { return }
      recognizer?.append(bytes)
    case "stop":
      guard let id, id == activeId else {
        if let id { emit(["type": "ended", "id": id]) }
        return
      }
      await stopActive(cancel: (object["cancel"] as? Bool) ?? false)
    case "shutdown":
      await stopActive(cancel: true)
      exit(0)
    default:
      emit(["type": "error", "code": "bad-command", "message": "Unknown command \(type)"])
    }
  }

  private func start(id: String, locale: String?, contextualStrings: [String], variant: String) async {
    activeId = id
    do {
      #if compiler(>=6.2)
      if #available(macOS 26, *), useAnalyzer() {
        let analyzer = AnalyzerRecognizer(id: id)
        recognizer = analyzer
        try await analyzer.start(localeIdentifier: locale, contextualStrings: contextualStrings, variant: variant)
        emit(["type": "ready", "id": id])
        return
      }
      #endif
      let legacy = LegacyRecognizer(id: id)
      recognizer = legacy
      try await legacy.start(localeIdentifier: locale, contextualStrings: contextualStrings)
      emit(["type": "ready", "id": id])
    } catch {
      emitError(id, error)
      recognizer = nil
      activeId = nil
      emit(["type": "ended", "id": id])
    }
  }

  private func stopActive(cancel: Bool) async {
    guard let id = activeId, let recognizer else { return }
    activeId = nil
    self.recognizer = nil
    await recognizer.stop(cancel: cancel)
    emit(["type": "ended", "id": id])
  }
}

func probe() async {
  var payload: [String: Any] = [
    "type": "probe",
    "engine": useAnalyzer() ? "speech-analyzer" : "sf-speech",
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "authorization": authorizationName(SFSpeechRecognizer.authorizationStatus()),
  ]
  #if compiler(>=6.2)
  if #available(macOS 26, *) {
    payload["speechTranscriberAvailable"] = SpeechTranscriber.isAvailable
  }
  #endif
  emit(payload)
}

let commands = AsyncStream<String> { continuation in
  let reader = Thread {
    while let line = readLine(strippingNewline: true) {
      if !line.isEmpty { continuation.yield(line) }
    }
    continuation.finish()
  }
  reader.start()
}

Task {
  if CommandLine.arguments.contains("--probe") {
    await probe()
    exit(0)
  }
  emit(["type": "hello", "engine": useAnalyzer() ? "speech-analyzer" : "sf-speech", "version": 1])
  let controller = Controller()
  for await line in commands {
    await controller.handle(line)
  }
  await controller.handle("{\"type\":\"shutdown\"}")
  exit(0)
}

dispatchMain()
