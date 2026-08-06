#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/export-tutorial-session.mjs --session-id <id> --tutorial-root <path> --port <port> --token <token> [--output <file>]",
    "",
    "The running app's read-only database_query MCP tool is used; this script never opens a database file.",
  ].join("\n");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(usage());
    }
    values.set(key.slice(2), value);
  }

  const sessionId = values.get("session-id");
  const tutorialRoot = values.get("tutorial-root");
  const port = Number(values.get("port"));
  const token = values.get("token");
  if (!sessionId || !tutorialRoot || !token || !Number.isInteger(port) || port <= 0) {
    throw new Error(usage());
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(sessionId)) {
    throw new Error("Session id contains unsupported characters.");
  }

  return {
    sessionId,
    tutorialRoot: path.resolve(tutorialRoot),
    port,
    token,
    output: values.get("output"),
  };
}

function readTextResult(result) {
  if (result.isError) {
    throw new Error(
      result.content
        ?.filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n") || "database_query failed"
    );
  }

  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("database_query returned no text result.");
  }
  return text;
}

function parseRows(text) {
  if (text.includes("No rows returned.")) {
    return [];
  }

  const jsonStart = text.indexOf("\n\n[");
  if (jsonStart === -1) {
    throw new Error(`Could not parse database_query response:\n${text}`);
  }
  const truncationStart = text.indexOf("\n\n... and ", jsonStart);
  const jsonText = text.slice(
    jsonStart + 2,
    truncationStart === -1 ? text.length : truncationStart
  );
  return JSON.parse(jsonText);
}

async function queryRows(client, sql) {
  const result = await client.callTool({
    name: "database_query",
    arguments: { sql },
  });
  return parseRows(readTextResult(result));
}

async function queryAllMessages(client, sessionId) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await queryRows(
      client,
      `SELECT direction, source, content, message_kind, hidden
       FROM ai_agent_messages
       WHERE session_id = '${sessionId}'
       ORDER BY created_at ASC, id ASC
       LIMIT 100 OFFSET ${offset}`
    );
    rows.push(...page);
    if (page.length < 100) {
      return rows;
    }
  }
}

function parseMetadata(value) {
  if (value === null || value === undefined || value === "") {
    return {};
  }
  return typeof value === "string" ? JSON.parse(value) : value;
}

function tokenizeTutorialRoot(content, tutorialRoot) {
  return content.replaceAll(tutorialRoot, "{{TUTORIAL_ROOT}}");
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === "true";
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const endpoint = new URL(`http://127.0.0.1:${args.port}/mcp`);
  endpoint.searchParams.set("sessionId", args.sessionId);
  endpoint.searchParams.set("workspaceId", args.tutorialRoot);

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `Bearer ${args.token}` },
    },
  });
  const client = new Client(
    { name: "tutorial-session-exporter", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const sessionRows = await queryRows(
      client,
      `SELECT provider, model, title, agent_role, metadata
       FROM ai_sessions
       WHERE id = '${args.sessionId}'
       LIMIT 1`
    );
    if (sessionRows.length !== 1) {
      throw new Error(`Session not found: ${args.sessionId}`);
    }

    const messages = await queryAllMessages(client, args.sessionId);
    const session = sessionRows[0];
    const fixture = {
      session: {
        provider: session.provider,
        model: session.model ?? undefined,
        title: session.title,
        agentRole: session.agent_role ?? undefined,
        metadata: parseMetadata(session.metadata),
      },
      messages: messages.map((message) => ({
        direction: message.direction,
        source: message.source,
        content: tokenizeTutorialRoot(message.content, args.tutorialRoot),
        messageKind: message.message_kind ?? "meta",
        hidden: normalizeBoolean(message.hidden),
      })),
    };
    const output = `${JSON.stringify(fixture, null, 2)}\n`;

    if (args.output) {
      await writeFile(path.resolve(args.output), output, "utf8");
    } else {
      process.stdout.write(output);
    }
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
