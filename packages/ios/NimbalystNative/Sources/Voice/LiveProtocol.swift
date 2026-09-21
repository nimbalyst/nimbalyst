import Foundation
import CoreFoundation

struct LiveCall: Equatable {
    let delegationId: String
    let responseId: String
    let itemId: String
    let callId: String
    let name: String
    let arguments: String
    // The app receives this opaque identity, never a potentially reused provider call_id.
    let token: String
}

public struct LiveUsage: Equatable, Sendable {
    public internal(set) var seconds: Double?
    public internal(set) var contextUsageRatio: Double?
    public internal(set) var finalized = false
    public internal(set) var finalizationMissing = false
    public internal(set) var backendInputTokens = 0
    public internal(set) var backendOutputTokens = 0
}

public struct LiveTranscript: Identifiable, Equatable, Sendable {
    public let id: String
    public let speaker: String
    public let startMs: Double
    public internal(set) var endMs: Double
    public internal(set) var text: String
}

/// Foundation-only, serial protocol state. Serialization is an application constraint:
/// Live's unaddressed result/continue commands cannot safely select an overlapping response.
struct LiveProtocolState {
    enum Effect {
        case ready, closed, audio(String), transcript, usage
        case call(LiveCall), backendStarted, backendFinished
    }
    private struct Response {
        let delegation: String
        let id: String
        var calls: [LiveCall] = []
        var outputs: [String: String] = [:]
        var terminal = false
        var reserved = false
        var sent = false
    }
    private var response: Response?
    private var seenEvents = Set<String>()
    private var retiredResponses = Set<String>()
    private var itemOwners: [String: String] = [:]
    private var backendUsageSeen = Set<String>()
    private(set) var ready = false
    private(set) var closed = false
    private(set) var fault: String?
    private(set) var sessionId = ""
    private(set) var usage = LiveUsage()
    private(set) var transcripts: [LiveTranscript] = []
    var busy: Bool { response.map { !$0.terminal || (!$0.calls.isEmpty && !$0.sent) } ?? false }

    mutating func fail(_ reason: String) { if fault == nil { fault = reason } }
    mutating func transportEnded() { closed = true; ready = false; usage.finalizationMissing = !usage.finalized }

    mutating func receive(_ raw: [String: Any]) -> [Effect] {
        guard let type = raw["type"] as? String else { fail("Invalid Live event"); return [] }
        if type != "session.output_audio.delta" {
            guard let id = raw["event_id"] as? String else { fail("Missing event identity"); return [] }
            guard seenEvents.insert(id).inserted else { return [] }
            guard seenEvents.count <= 50000 else { fail("Live event limit reached; resume voice"); return [] }
        }
        // Final usage must survive a fault or locally requested close.
        if type == "session.closed" {
            updateUsage(raw)
            usage.finalized = number((raw["usage"] as? [String: Any])?["seconds"]) != nil
            usage.finalizationMissing = !usage.finalized
            closed = true; ready = false
            return [.usage, .closed]
        }
        guard !closed, fault == nil else { return [] }
        switch type {
        case "session.started":
            guard !ready, let session = raw["session"] as? [String: Any], let id = session["id"] as? String,
                  session["model"] as? String == "gpt-live-1" else { fail("Invalid Live session startup"); return [] }
            sessionId = id; ready = true
            return [.ready]
        case "session.output_audio.delta":
            guard ready, let audio = raw["delta"] as? String, let bytes = Data(base64Encoded: audio), bytes.count % 2 == 0 else {
                fail("Invalid Live audio"); return []
            }
            return [.audio(audio)]
        case "session.input_transcript.delta", "session.output_transcript.delta":
            guard ready, let text = raw["delta"] as? String, let start = number(raw["start_ms"]),
                  let end = number(raw["end_ms"]), end >= start else { fail("Invalid Live transcript"); return [] }
            let speaker = type == "session.input_transcript.delta" ? "user" : "assistant"
            // Append contiguous fragments, including late fragments after the other speaker.
            if let index = transcripts.lastIndex(where: { $0.speaker == speaker && $0.endMs == start }) {
                transcripts[index].text += text
                transcripts[index].endMs = end
            } else {
                transcripts.append(.init(id: UUID().uuidString, speaker: speaker, startMs: start, endMs: end, text: text))
            }
            if transcripts.count > 100 { transcripts.removeFirst(transcripts.count - 100) }
            return [.transcript]
        case "session.usage.updated": updateUsage(raw); return [.usage]
        case "response.event": return receiveResponse(raw)
        default: return []
        }
    }

    private mutating func receiveResponse(_ raw: [String: Any]) -> [Effect] {
        guard ready, let event = raw["event"] as? [String: Any], let type = event["type"] as? String else {
            fail("Invalid delegated event"); return []
        }
        let actionable = ["response.created", "response.completed", "response.failed", "response.incomplete", "response.output_item.added", "response.output_item.done"]
        guard actionable.contains(type) else { return [] }
        guard let delegation = raw["delegation_id"] as? String else { fail("Uncorrelated delegation"); return [] }
        if type == "response.created" {
            guard let value = event["response"] as? [String: Any], let id = value["id"] as? String else { fail("Missing response identity"); return [] }
            if response?.id == id {
                if response?.delegation != delegation { fail("Response identity conflict") }
                return []
            }
            guard !retiredResponses.contains(id), !busy else { fail("live_delegation_serialization: overlapping responses"); return [] }
            if let response { retiredResponses.insert(response.id) }
            response = Response(delegation: delegation, id: id)
            return [.backendStarted]
        }
        guard var current = response, current.delegation == delegation else { fail("Uncorrelated response"); return [] }
        if type == "response.output_item.done" || type == "response.output_item.added" {
            guard let item = event["item"] as? [String: Any], let itemId = item["id"] as? String else { fail("Missing item identity"); return [] }
            if let responseId = event["response_id"] as? String, responseId != current.id {
                fail("Item response identity conflict"); return []
            }
            let key = delegation + ":" + itemId
            if let owner = itemOwners[key], owner != current.id { fail("Item identity conflict"); return [] }
            itemOwners[key] = current.id
            guard !current.terminal, type == "response.output_item.done", item["type"] as? String == "function_call" else { return [] }
            guard item["status"] == nil || item["status"] as? String == "completed" else { return [] }
            guard let callId = item["call_id"] as? String, let name = item["name"] as? String,
                  let args = item["arguments"] as? String,
                  let data = args.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { fail("Invalid function call"); return [] }
            if let old = current.calls.first(where: { $0.callId == callId || $0.itemId == itemId }) {
                if old.callId != callId || old.itemId != itemId || old.arguments != args || old.name != name { fail("Call identity conflict") }
                return []
            }
            let call = LiveCall(delegationId: delegation, responseId: current.id, itemId: itemId, callId: callId, name: name, arguments: args, token: UUID().uuidString)
            current.calls.append(call); response = current
            return [.call(call)]
        }
        guard let value = event["response"] as? [String: Any], value["id"] as? String == current.id else { fail("Terminal response identity conflict"); return [] }
        if current.terminal { return [] }
        if type != "response.completed" { fail("Delegated response failed or incomplete"); return [] }
        current.terminal = true; response = current
        if backendUsageSeen.insert(current.id).inserted, let tokens = value["usage"] as? [String: Any] {
            usage.backendInputTokens += Int(number(tokens["input_tokens"]) ?? 0)
            usage.backendOutputTokens += Int(number(tokens["output_tokens"]) ?? 0)
        }
        return [.backendFinished, .usage]
    }

    mutating func accept(token: String, output: String) -> Bool {
        guard !closed, fault == nil, var current = response, !current.reserved,
              current.calls.contains(where: { $0.token == token }), current.outputs[token] == nil else { return false }
        current.outputs[token] = output; response = current
        return true
    }

    /// Reserve before sending. A partial send faults the session; never replay side effects.
    mutating func takeResults() -> [[String: Any]] {
        guard !closed, fault == nil, var current = response, current.terminal, !current.reserved,
              !current.calls.isEmpty, current.calls.allSatisfy({ current.outputs[$0.token] != nil }) else { return [] }
        current.reserved = true; response = current
        return current.calls.map { call in
            ["type": "response.item.create", "item": ["type": "function_call_output", "call_id": call.callId, "output": current.outputs[call.token]!] as [String: Any]] as [String: Any]
        } + [["type": "response.create"]]
    }
    mutating func resultsSent() { response?.sent = true }

    private func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue >= 0 else { return nil }
        return value.doubleValue
    }
    private mutating func updateUsage(_ raw: [String: Any]) {
        if let data = raw["usage"] as? [String: Any], let seconds = number(data["seconds"]) { usage.seconds = max(usage.seconds ?? 0, seconds) }
        if let data = raw["context_window"] as? [String: Any], let ratio = number(data["usage_ratio"]), ratio <= 1 { usage.contextUsageRatio = ratio }
    }
}
