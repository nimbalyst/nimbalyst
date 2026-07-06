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

    /// Default model and the fallback used when the account/region lacks
    /// access. Mirrors PRIMARY_MODEL/FALLBACK_MODEL in the desktop
    /// RealtimeAPIClient.ts so both platforms speak to the same model.
    static let primaryModel = "gpt-realtime-2"
    static let fallbackModel = "gpt-realtime"

    /// Streaming transcription model for the GA Realtime API (replaces the
    /// legacy post-hoc whisper-1). Sent regardless of the active model, same
    /// as desktop: the gpt-realtime fallback accepts it too.
    static let transcriptionModel = "gpt-realtime-whisper"

    /// The model the client is currently connected with (post-fallback).
    private(set) var model: String = RealtimeClient.primaryModel
    /// True once we've fallen back from gpt-realtime-2 to gpt-realtime for
    /// this client (no account/region access). Prevents a fallback loop.
    private var usedModelFallback = false
    /// True once session.created has arrived on the current connection. A
    /// socket that dies before this is treated as "model unavailable" and
    /// triggers the one-shot model fallback (desktop connect() parity).
    private(set) var hasEstablishedSession = false

    /// GPT-5-class reasoning throttle, sent at the session top level as
    /// reasoning.effort. 'low' matches the desktop default; the gpt-realtime
    /// fallback ignores the unknown field, so it is always included.
    var reasoningEffort = "low"

    private var apiKey: String
    var voice: String = "alloy"
    var instructions: String = ""
    var tools: [[String: Any]] = []
    var vadThreshold: Double = 0.85
    var silenceDurationMs: Int = 500

    /// Turn-detection engine. semantic_vad (default) is model-judged and
    /// echo-robust; server_vad is the amplitude fallback for A/B comparison
    /// (vadThreshold/silenceDurationMs only apply to it). Mirrors the desktop
    /// buildTurnDetection in voiceBargeInPolicy.ts.
    var vadDetection: VadDetection = .semanticVad

    /// Input noise-reduction profile. "far_field" is OpenAI's documented
    /// speakerphone optimization and directly targets residual-echo VAD trips
    /// (NIM-1314); iPhones in voice mode are effectively far-field devices.
    /// nil omits the config (API default).
    var noiseReductionType: String? = "far_field"

    // MARK: - State

    private var currentResponseId: String?
    /// True once onSessionReady has fired for the current connection; reset by
    /// session.created. Later session.updated events (gating flips) are silent.
    private var hasFiredSessionReady = false
    private(set) var hasActiveResponse = false
    private var functionCallBuffer: [String: String] = [:]  // call_id -> accumulated arguments

    /// The conversation item currently streaming (or last streamed) assistant
    /// audio. Kept past response.done because playback outlives the response
    /// (audio streams faster than realtime); a barge-in during that tail must
    /// truncate THIS item. Cleared once truncated.
    private(set) var currentAssistantItemId: String?

    /// While the agent's audio is audibly playing, server VAD responses are
    /// gated (create_response/interrupt_response = false) so residual echo
    /// cannot make the server act on its own voice; the client keeps barge-in
    /// control. Restored when playback ends (NIM-1314 lever 4).
    private(set) var serverResponsesGated = false

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

    /// The WebSocket endpoint for the current model. Internal (not private)
    /// so config-shape tests can assert the model without opening a socket.
    var connectionURL: URL? {
        URL(string: "wss://api.openai.com/v1/realtime?model=\(model)")
    }

    func connect() {
        isIntentionallyClosed = false
        hasNotifiedDisconnect = false
        hasEstablishedSession = false

        guard let url = connectionURL else {
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
        currentAssistantItemId = nil
        serverResponsesGated = false
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

    /// Maximum instructions length. The cap is model-aware: gpt-realtime
    /// crashes mid-audio-generation with no useful error when instructions
    /// exceed ~2000 chars (hard-won), so the fallback keeps that guard.
    /// gpt-realtime-2 handles long instructions -- desktop ships ~5k-char
    /// instructions on it live -- so the primary model gets headroom instead
    /// of silently truncating (the LANGUAGE pin is appended last and was the
    /// first thing a 2000-char truncation cut off).
    var maxInstructionsLength: Int {
        model == Self.fallbackModel ? 2000 : 8000
    }

    /// Update the session configuration (voice, tools, instructions, VAD).
    func updateSession() {
        var safeInstructions = instructions
        if safeInstructions.count > maxInstructionsLength {
            logger.error("Instructions too long (\(safeInstructions.count) chars), truncating to \(self.maxInstructionsLength). This likely means dynamic content (session lists) leaked into instructions.")
            safeInstructions = String(safeInstructions.prefix(maxInstructionsLength))
        }

        // Mirrors the desktop session.update log line so a pasted device log
        // shows exactly which engine/model/config was sent (NIM-1471 gap).
        logger.info("session.update: model=\(self.model) voice=\(self.voice) vad=\(self.vadDetection.rawValue) reasoning=\(self.reasoningEffort) transcription=\(Self.transcriptionModel) gated=\(self.serverResponsesGated)")
        sendEvent([
            "type": "session.update",
            "session": buildSessionConfig(instructions: safeInstructions),
        ])
    }

    /// Build the audio.input turn_detection config. `allowServerResponses`
    /// maps to the GA `create_response` / `interrupt_response` flags: false
    /// while the agent is audibly speaking so echo-triggered VAD cannot make
    /// the server cancel the response or answer its own voice.
    func buildTurnDetection(allowServerResponses: Bool) -> [String: Any] {
        switch vadDetection {
        case .semanticVad:
            return [
                "type": "semantic_vad",
                "eagerness": "auto",
                "create_response": allowServerResponses,
                "interrupt_response": allowServerResponses,
            ]
        case .serverVad:
            return [
                "type": "server_vad",
                "threshold": vadThreshold,
                "prefix_padding_ms": 300,
                "silence_duration_ms": silenceDurationMs,
                "create_response": allowServerResponses,
                "interrupt_response": allowServerResponses,
            ]
        }
    }

    /// GA Realtime API session shape. Audio config is nested under audio.{input,output}
    /// with format as an object ({type,rate}), not the flat beta fields. The audio
    /// pipeline uses 24kHz PCM16 in both directions (see AudioPipeline.kApiSampleRate).
    func buildSessionConfig(instructions: String) -> [String: Any] {
        var inputConfig: [String: Any] = [
            "format": [
                "type": "audio/pcm",
                "rate": 24000,
            ] as [String: Any],
            // Streaming transcription (replaces post-hoc whisper-1) -- faster,
            // more accurate partial captions (desktop parity).
            "transcription": [
                "model": Self.transcriptionModel
            ],
            "turn_detection": buildTurnDetection(allowServerResponses: !serverResponsesGated),
        ]
        if let noiseReductionType {
            inputConfig["noise_reduction"] = ["type": noiseReductionType]
        }

        var sessionConfig: [String: Any] = [
            "type": "realtime",
            "output_modalities": ["audio"],
            "instructions": instructions,
            // GPT-5-class reasoning throttle (gpt-realtime-2). The gpt-realtime
            // fallback ignores an unknown field, so it's safe to always include
            // (desktop parity).
            "reasoning": ["effort": reasoningEffort],
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
        return sessionConfig
    }

    /// Gate or un-gate server VAD responses while the agent's audio plays.
    /// Sends a partial session.update touching only turn_detection. No-ops
    /// when the state is unchanged (this fires on every turn boundary).
    func setServerResponsesGated(_ gated: Bool) {
        guard gated != serverResponsesGated else { return }
        serverResponsesGated = gated
        logger.info("[barge-in] server responses gated=\(gated)")
        sendEvent([
            "type": "session.update",
            "session": [
                "type": "realtime",
                "audio": [
                    "input": [
                        "turn_detection": buildTurnDetection(allowServerResponses: !gated)
                    ] as [String: Any]
                ] as [String: Any],
            ] as [String: Any],
        ])
    }

    /// Tell the server how much of the current assistant item's audio the user
    /// actually heard before a barge-in, so the model's context matches
    /// reality. Without this the model believes the user heard the full reply.
    /// Clears the item id so the same item is never truncated twice.
    func truncatePlayedAudio(audioEndMs: Int) {
        guard let itemId = currentAssistantItemId else { return }
        currentAssistantItemId = nil
        sendEvent([
            "type": "conversation.item.truncate",
            "item_id": itemId,
            "content_index": 0,
            "audio_end_ms": max(0, audioEndMs),
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

    // Internal (not private) so protocol-shape tests can feed synthetic events.
    func handleMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "session.created":
            logger.info("Realtime session created (model=\(self.model))")
            audioChunksSent = 0
            hasEstablishedSession = true
            hasFiredSessionReady = false
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
            // Fire the ready ritual (capture start, chime, .listening) ONCE per
            // connection. Response-gating flips send partial session.updates
            // mid-conversation and the server echoes session.updated for each;
            // re-firing replayed the ready chime into the mic and fed an echo
            // interrupt loop (NIM-1471).
            if !hasFiredSessionReady {
                hasFiredSessionReady = true
                onSessionReady?()
            }

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
            if let itemId = json["item_id"] as? String {
                currentAssistantItemId = itemId
            }
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

    /// One-shot model fallback (desktop connect() parity): when gpt-realtime-2
    /// isn't available to this account/region, switch to gpt-realtime so voice
    /// mode still works. Returns true when the fallback was applied (caller
    /// should reconnect). Internal so the decision is unit-testable.
    func attemptModelFallback() -> Bool {
        guard model == Self.primaryModel, !usedModelFallback else { return false }
        usedModelFallback = true
        model = Self.fallbackModel
        return true
    }

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
        currentAssistantItemId = nil
        serverResponsesGated = false

        guard !isIntentionallyClosed else { return }

        // A connection that died before session.created means the model itself
        // was rejected (or the network flaked -- the desktop accepts the same
        // ambiguity): retry once on the fallback model before giving up.
        if !hasEstablishedSession, attemptModelFallback() {
            logger.warning("\(Self.primaryModel) unavailable, falling back to \(Self.fallbackModel)")
            connect()
            return
        }

        // Only notify once per connection cycle to prevent cascading disconnects.
        // Intentional divergence from desktop: no exponential-backoff reconnect
        // here -- iOS tears down voice mode on connection loss (URLSession's
        // waitsForConnectivity absorbs transient drops, the app is frequently
        // backgrounded mid-session, and the user re-taps the mic to resume).
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
