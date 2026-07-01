import Foundation
import os

/// Handles the OpenAI Realtime API WebSocket protocol.
/// Manages connection lifecycle, audio streaming, tool calls, and token tracking.
@MainActor
final class RealtimeClient {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "RealtimeClient")

    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private var isIntentionallyClosed = false

    // MARK: - Configuration

    private var apiKey: String
    var voice: String = "cedar"
    var instructions: String = ""
    var tools: [[String: Any]] = []
    var vadThreshold: Double = 0.5
    var silenceDurationMs: Int = 500

    // MARK: - State

    private var currentResponseId: String?
    private(set) var hasActiveResponse = false
    private var functionCallBuffer: [String: String] = [:]  // call_id -> accumulated arguments

    /// Serialize responses. Overlapping responses (e.g. several tool results each
    /// triggering response.create) interleave their audio deltas into one playback
    /// buffer -> garbled speech. `responseInFlight` is true between sending
    /// response.create and the matching response.done; while it (or
    /// hasActiveResponse) is set, a new request is coalesced into a single
    /// follow-up sent after the active response finishes.
    private var responseInFlight = false
    private var pendingResponseRequest = false

    /// After a barge-in cancel, audio deltas for the cancelled response may still
    /// be in flight over the socket. Drop them until the next response starts so
    /// the agent's voice doesn't briefly resume after the user interrupted.
    private var discardingAudio = false

    // MARK: - Callbacks

    var onConnected: (() -> Void)?
    var onSessionReady: (() -> Void)?   // Fired after session.updated - safe to send audio
    var onDisconnected: (() -> Void)?
    var onAudioDelta: ((String) -> Void)?         // base64 PCM16 audio chunk
    var onAudioDone: (() -> Void)?
    var onTextDelta: ((String) -> Void)?
    var onFunctionCall: ((String, String, String) -> Void)?  // name, arguments JSON, call_id
    var onFunctionResultSent: ((String) -> Void)?  // call_id — fired when a tool result is sent
    var onSpeechStarted: (() -> Void)?
    var onSpeechStopped: (() -> Void)?
    var onError: ((String, String) -> Void)?       // type, message
    var onTokenUsage: ((TokenUsage) -> Void)?
    var onResponseCreated: (() -> Void)?
    var onResponseDone: (() -> Void)?

    struct TokenUsage {
        let inputTokens: Int
        let outputTokens: Int
        let inputAudioTokens: Int
        let outputAudioTokens: Int
    }

    // MARK: - Init

    init(apiKey: String) {
        self.apiKey = apiKey
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    deinit {
        task?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Connection

    func connect() {
        isIntentionallyClosed = false
        hasNotifiedDisconnect = false

        guard let url = URL(string: "wss://api.openai.com/v1/realtime?model=gpt-realtime") else {
            logger.error("Invalid Realtime API URL")
            return
        }

        // Use subprotocol auth - more reliable than header auth.
        // Do NOT include the "openai-beta.realtime-v1" subprotocol: it selects the
        // retired Beta API shape, which the server now rejects with
        // code=4000 reason=beta_api_shape_disabled. Omitting it selects the GA shape.
        let protocols = [
            "realtime",
            "openai-insecure-api-key.\(apiKey)",
        ]

        let wsTask = session.webSocketTask(with: url, protocols: protocols)
        wsTask.maximumMessageSize = 16 * 1024 * 1024
        self.task = wsTask
        wsTask.resume()

        startReceiving()
        logger.info("Connecting to OpenAI Realtime API")
    }

    func disconnect() {
        isIntentionallyClosed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        hasActiveResponse = false
        responseInFlight = false
        pendingResponseRequest = false
        discardingAudio = false
        currentResponseId = nil
        functionCallBuffer.removeAll()
        // Don't call onDisconnected here - that's for unexpected disconnects only.
        // Intentional disconnects are initiated by the caller (VoiceAgent.deactivate).
    }

    // MARK: - Send Events

    /// Send a base64-encoded PCM16 audio chunk.
    func sendAudio(_ base64Audio: String) {
        audioChunksSent += 1
        sendEvent([
            "type": "input_audio_buffer.append",
            "audio": base64Audio,
        ])
    }

    /// Commit the audio buffer for processing (push-to-talk mode).
    func commitAudioBuffer() {
        sendEvent(["type": "input_audio_buffer.commit"])
    }

    /// Cancel the current response (user interruption / barge-in). Optimistically
    /// clears local response state so a racing "no active response" error isn't
    /// produced, drops any queued follow-up, and discards in-flight audio.
    func cancelResponse() {
        sendEvent(["type": "response.cancel"])
        hasActiveResponse = false
        responseInFlight = false
        pendingResponseRequest = false
        discardingAudio = true
    }

    /// Request a new response from the assistant. Serialized: if a response is
    /// already active or in flight, the request is coalesced and a single
    /// follow-up is sent after the active response's response.done.
    func createResponse() {
        if hasActiveResponse || responseInFlight {
            pendingResponseRequest = true
            return
        }
        sendResponseCreate()
    }

    private func sendResponseCreate() {
        responseInFlight = true
        pendingResponseRequest = false
        sendEvent(["type": "response.create"])
    }

    /// Send a coalesced follow-up response once the prior one finished, unless a
    /// barge-in cleared it.
    private func flushPendingResponse() {
        guard pendingResponseRequest, !hasActiveResponse, !responseInFlight else { return }
        sendResponseCreate()
    }

    /// Send a function call result back to the conversation.
    func sendFunctionCallResult(callId: String, output: String) {
        sendEvent([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callId,
                "output": output,
            ],
        ])
        onFunctionResultSent?(callId)
        // Trigger a new response after providing tool result
        createResponse()
    }

    /// Insert a system-level text message into the conversation (for internal notifications).
    func sendUserMessage(text: String) {
        sendEvent([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_text",
                        "text": text,
                    ]
                ],
            ],
        ])
        createResponse()
    }

    /// Maximum instructions length to avoid gpt-realtime server errors.
    /// The model crashes mid-audio-generation with no useful error if instructions are too long.
    private static let kMaxInstructionsLength = 2000

    /// Update the session configuration (voice, tools, instructions, VAD).
    func updateSession() {
        var safeInstructions = instructions
        if safeInstructions.count > Self.kMaxInstructionsLength {
            logger.error("Instructions too long (\(safeInstructions.count) chars), truncating to \(Self.kMaxInstructionsLength). This likely means dynamic content (session lists) leaked into instructions.")
            safeInstructions = String(safeInstructions.prefix(Self.kMaxInstructionsLength))
        }

        // GA Realtime API session shape. Audio config is nested under audio.{input,output}
        // with format as an object ({type,rate}), not the flat beta fields. The audio
        // pipeline uses 24kHz PCM16 in both directions (see AudioPipeline.kApiSampleRate).
        let inputConfig: [String: Any] = [
            "format": [
                "type": "audio/pcm",
                "rate": 24000,
            ] as [String: Any],
            "transcription": [
                "model": "whisper-1"
            ],
            "turn_detection": [
                "type": "server_vad",
                "threshold": vadThreshold,
                "prefix_padding_ms": 300,
                "silence_duration_ms": silenceDurationMs,
            ] as [String: Any],
        ]

        var sessionConfig: [String: Any] = [
            "type": "realtime",
            "output_modalities": ["audio"],
            "instructions": safeInstructions,
            "audio": [
                "input": inputConfig,
                "output": [
                    "voice": voice,
                    "format": [
                        "type": "audio/pcm",
                        "rate": 24000,
                    ] as [String: Any],
                ] as [String: Any],
            ] as [String: Any],
        ]

        if !tools.isEmpty {
            sessionConfig["tools"] = tools
        }

        sendEvent([
            "type": "session.update",
            "session": sessionConfig,
        ])
    }

    // MARK: - Receive Loop

    private func startReceiving() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }

                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8) {
                            self.handleMessage(data)
                        }
                    case .data(let data):
                        self.handleMessage(data)
                    @unknown default:
                        break
                    }
                    self.startReceiving()

                case .failure(let error):
                    let nsError = error as NSError
                    self.logger.error("WebSocket receive error: \(error.localizedDescription) (domain: \(nsError.domain), code: \(nsError.code))")
                    self.handleDisconnect()
                }
            }
        }
    }

    // MARK: - Message Handling

    private var audioChunksSent = 0
    private var audioResponseChunks = 0
    private var textDeltaCount = 0

    private func handleMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "session.created":
            logger.info("Realtime session created")
            audioChunksSent = 0
            updateSession()
            onConnected?()

        case "session.updated":
            if let session = json["session"] as? [String: Any] {
                // GA nests voice under audio.output.voice (was top-level in beta).
                let audioOutput = (session["audio"] as? [String: Any])?["output"] as? [String: Any]
                let voice = audioOutput?["voice"] as? String ?? session["voice"] as? String ?? "none"
                let tools = session["tools"] as? [[String: Any]] ?? []
                logger.info("Session updated: voice=\(voice), tools=\(tools.count)")
            }
            onSessionReady?()

        case "response.created":
            if let response = json["response"] as? [String: Any] {
                currentResponseId = response["id"] as? String
            }
            hasActiveResponse = true
            responseInFlight = true
            discardingAudio = false
            onResponseCreated?()

        case "response.done":
            hasActiveResponse = false
            responseInFlight = false
            textDeltaCount = 0
            handleResponseDone(json)
            onResponseDone?()
            flushPendingResponse()

        // GA event is response.output_audio.delta; the beta name is kept for safety.
        case "response.output_audio.delta", "response.audio.delta":
            if discardingAudio { break }
            audioResponseChunks += 1
            if let delta = json["delta"] as? String {
                onAudioDelta?(delta)
            }

        case "response.output_audio.done", "response.audio.done":
            audioResponseChunks = 0
            onAudioDone?()

        case "response.output_text.delta", "response.text.delta":
            if let delta = json["delta"] as? String {
                textDeltaCount += 1
                onTextDelta?(delta)
            }

        case "response.function_call_arguments.delta":
            if let callId = json["call_id"] as? String,
               let delta = json["delta"] as? String {
                functionCallBuffer[callId, default: ""] += delta
            }

        case "response.function_call_arguments.done":
            handleFunctionCallDone(json)

        case "input_audio_buffer.speech_started":
            onSpeechStarted?()

        case "input_audio_buffer.speech_stopped":
            onSpeechStopped?()

        case "input_audio_buffer.committed":
            break

        case "error":
            if let error = json["error"] as? [String: Any] {
                let errorType = error["type"] as? String ?? "unknown"
                let message = error["message"] as? String ?? "Unknown error"
                // A cancel that races a response finishing is harmless -- we
                // already cleared local state in cancelResponse(). Don't surface it.
                if message.contains("no active response") || message.contains("Cancellation failed") {
                    logger.debug("Ignoring benign cancel race: \(message)")
                    break
                }
                logger.error("Realtime API error [\(errorType)]: \(message)")
                // The in-flight response failed -- release the serialization lock
                // so a coalesced follow-up can still be sent.
                responseInFlight = false
                onError?(errorType, message)
                flushPendingResponse()
            }

        case "response.output_audio_transcript.delta", "response.output_audio_transcript.done",
             "response.audio_transcript.delta", "response.audio_transcript.done":
            // Audio transcript events - informational
            break

        case "conversation.item.created", "conversation.item.input_audio_transcription.completed",
             "conversation.item.input_audio_transcription.delta":
            break

        case "rate_limits.updated":
            break

        case "response.output_item.added", "response.output_item.done",
             "response.content_part.added", "response.content_part.done",
             "response.output_text.done", "response.text.done":
            break

        default:
            break
        }
    }

    private func handleResponseDone(_ json: [String: Any]) {
        guard let response = json["response"] as? [String: Any],
              let usage = response["usage"] as? [String: Any] else {
            return
        }

        let inputTokens = usage["input_tokens"] as? Int ?? 0
        let outputTokens = usage["output_tokens"] as? Int ?? 0

        let inputDetails = usage["input_token_details"] as? [String: Any]
        let outputDetails = usage["output_token_details"] as? [String: Any]
        let inputAudio = inputDetails?["audio_tokens"] as? Int ?? 0
        let outputAudio = outputDetails?["audio_tokens"] as? Int ?? 0

        onTokenUsage?(TokenUsage(
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            inputAudioTokens: inputAudio,
            outputAudioTokens: outputAudio
        ))

        // Check for error status
        if let status = response["status"] as? String, status != "completed" {
            if let details = response["status_details"] as? [String: Any],
               let error = details["error"] as? [String: Any] {
                let errorType = error["type"] as? String ?? "unknown"
                let message = error["message"] as? String ?? "Response failed"
                onError?(errorType, message)
            }
        }
    }

    private func handleFunctionCallDone(_ json: [String: Any]) {
        guard let callId = json["call_id"] as? String,
              let name = json["name"] as? String else {
            return
        }

        let arguments = json["arguments"] as? String ?? functionCallBuffer[callId] ?? "{}"
        functionCallBuffer.removeValue(forKey: callId)

        logger.info("Function call: \(name)")
        onFunctionCall?(name, arguments, callId)
    }

    // MARK: - Reconnection

    private var hasNotifiedDisconnect = false

    private func handleDisconnect() {
        // Log the WebSocket close code before clearing the task
        if let wsTask = task {
            let closeCode = wsTask.closeCode.rawValue
            let closeReason = wsTask.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "none"
            logger.error("WebSocket closed: code=\(closeCode), reason=\(closeReason)")
        }

        task = nil
        hasActiveResponse = false
        responseInFlight = false
        pendingResponseRequest = false
        discardingAudio = false
        currentResponseId = nil

        guard !isIntentionallyClosed else { return }
        // Only notify once per connection cycle to prevent cascading disconnects
        guard !hasNotifiedDisconnect else { return }
        hasNotifiedDisconnect = true

        logger.info("Realtime connection lost, notifying delegate")
        onDisconnected?()
    }

    // MARK: - Internal

    private func sendEvent(_ event: [String: Any]) {
        guard let task else { return }

        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else {
            logger.error("Failed to serialize event")
            return
        }

        task.send(.string(json)) { [weak self] error in
            if let error {
                let nsError = error as NSError
                Task { @MainActor in
                    self?.logger.error("Send error: \(error.localizedDescription) (domain: \(nsError.domain), code: \(nsError.code))")
                }
            }
        }
    }
}
