import {
  isVoiceModeActive,
  sendToVoiceAgent,
  getActiveVoiceSessionId,
  stopVoiceSession,
} from "../../services/voice/VoiceModeService";

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export const voiceToolSchemas = [
  {
    name: "voice_agent_speak",
    description:
      "Send a message to the voice agent to be spoken aloud to the user. This tool serves as a communication bridge between the coding agent and the voice agent, enabling the coding agent to provide spoken updates, task completion notifications, or responses to the user during voice mode sessions. Use this when you want to inform the user about progress or results while they are interacting via voice. If voice mode is not active, this tool will return a non-error response indicating voice is unavailable. Keep messages concise and conversational.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The message for the voice agent to speak to the user. Be concise and natural. This enables the coding agent to communicate with the user through the voice agent.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "voice_agent_stop",
    description:
      "Stop the current voice mode session. Use this to end voice interactions when the conversation is complete, when the user requests to stop, or when transitioning away from voice mode. This will disconnect from the voice service and clean up resources. Returns success if a session was stopped, or indicates if no session was active.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

export function handleVoiceAgentSpeak(args: any): McpToolResult {
  const message = args?.message as string | undefined;

  if (!message || typeof message !== "string") {
    return {
      content: [
        {
          type: "text",
          text: "Error: message parameter is required and must be a string",
        },
      ],
      isError: true,
    };
  }

  // Get the active voice session directly - works regardless of document state
  const activeVoiceSessionId = getActiveVoiceSessionId();

  if (!activeVoiceSessionId) {
    return {
      content: [
        {
          type: "text",
          text: "Voice mode is not currently active. The message cannot be spoken aloud. You can still respond to the user via text in the normal way.",
        },
      ],
      isError: false, // Not a hard error - just means voice mode isn't active
    };
  }

  // Attempt to send message to voice agent
  const success = sendToVoiceAgent(activeVoiceSessionId, message);

  if (!success) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to send message to voice agent. The voice connection may have been lost or disconnected. You can still respond to the user via text in the normal way.`,
        },
      ],
      isError: false, // Not a hard error - voice agent just isn't reachable
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Message queued for voice agent: "${message.substring(
          0,
          100
        )}${message.length > 100 ? "..." : ""}"`,
      },
    ],
    isError: false,
  };
}

export function handleVoiceAgentStop(): McpToolResult {
  const wasActive = stopVoiceSession();

  if (wasActive) {
    return {
      content: [
        {
          type: "text",
          text: "Voice mode session has been stopped successfully.",
        },
      ],
      isError: false,
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: "No active voice mode session to stop.",
        },
      ],
      isError: false, // Not a hard error - just means no session was active
    };
  }
}
