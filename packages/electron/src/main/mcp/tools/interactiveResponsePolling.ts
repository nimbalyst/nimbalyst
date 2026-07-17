type InteractiveResponseMessage = {
  content: string;
  createdAt?: Date | string;
};

export function findFreshInteractiveResponse(
  messages: InteractiveResponseMessage[],
  options: {
    expectedType: string;
    idFields: readonly string[];
    acceptedIds: ReadonlySet<string>;
    notBefore: number;
  },
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const createdAt = message.createdAt instanceof Date
      ? message.createdAt.getTime()
      : typeof message.createdAt === "string"
        ? Date.parse(message.createdAt)
        : Number.NaN;
    if (!Number.isFinite(createdAt) || createdAt < options.notBefore) continue;

    try {
      const content = JSON.parse(message.content) as Record<string, unknown>;
      if (content.type !== options.expectedType) continue;
      const matches = options.idFields.some((field) => {
        const value = content[field];
        return typeof value === "string" && options.acceptedIds.has(value);
      });
      if (matches) return content;
    } catch {
      // Non-JSON transcript rows are unrelated to interactive responses.
    }
  }
  return null;
}
