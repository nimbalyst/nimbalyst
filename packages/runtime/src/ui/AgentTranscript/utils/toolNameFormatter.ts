/**
 * Format MCP tool identifiers into a readable label for the transcript UI.
 * Falls back to the original name if it doesn't follow the expected pattern.
 */
export function formatToolDisplayName(toolName?: string): string {
  if (!toolName) {
    return '';
  }

  const trimmed = toolName.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === 'command_execution' || trimmed === 'shell' || trimmed === 'exec_command') {
    return 'Bash';
  }

  if (trimmed === 'file_change') {
    return 'File Change';
  }

  if (trimmed === 'web_search') {
    return 'Web Search';
  }

  const parts = trimmed.split('__').filter(part => part.length > 0);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'mcp') {
    return trimmed;
  }

  const serverSegment = parts[1];
  const toolSegment = parts.slice(2).join('__');

  if (!serverSegment || !toolSegment) {
    return trimmed;
  }

  const prettify = (segment: string): string => {
    return segment
      .split(/[-_]/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  const formattedServer = prettify(serverSegment);
  const formattedTool = prettify(toolSegment);

  if (!formattedServer && !formattedTool) {
    return trimmed;
  }

  if (!formattedServer) {
    return formattedTool;
  }

  if (!formattedTool) {
    return `${formattedServer} MCP`;
  }

  return `${formattedTool} - ${formattedServer}`;
}
