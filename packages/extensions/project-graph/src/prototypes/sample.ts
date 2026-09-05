import type { ProjectGraphNode, ProjectGraphSnapshot } from "../types";

/** Deliberately large, deterministic demonstration corpus. Never mixed into live data. */
export function createPrototypeSample(now = Date.now()): ProjectGraphSnapshot {
  const day = 86_400_000;
  const topics = [
    "session-continuity",
    "queue-reliability",
    "editor-navigation",
    "shared-documents",
    "tracker-sharing",
    "decision-provenance",
    "release-verification",
    "customer-learning",
  ];
  const titles = [
    "Resume interrupted work",
    "Explain queued work",
    "Preserve editor context",
    "Inspect shared document access",
    "Link tracker evidence",
    "Trace a design decision",
    "Verify a release candidate",
    "Understand a customer request",
  ];
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphSnapshot["edges"] = [];
  for (let i = 0; i < 200; i++) {
    const createdAt = now - (15 + (i % 75)) * day;
    nodes.push({
      id: `sample:plan:${i}`,
      label: `${titles[i % titles.length]} · ${i + 1}`,
      type: "plan",
      source: "tracker",
      category: "strategy",
      visibility: "local",
      status: i % 3 ? "in-progress" : "in-review",
      tags: [topics[i % topics.length]!],
      fields: {
        createdAt,
        data: {
          activity: [
            {
              action: "status_changed",
              timestamp: now - (i % 14) * day - 3_600_000,
              newValue: i % 3 ? "in-progress" : "in-review",
            },
          ],
        },
      },
    });
  }
  for (let i = 0; i < 2000; i++) {
    const age = (i % 40) * day + (i % 12) * 3_600_000;
    const createdAt = now - age - 2 * day;
    const recent = i % 8 === 0 ? now - 3 * day : now - age;
    nodes.push({
      id: `sample:session:${i}`,
      label: `${titles[i % titles.length]} / exploration ${i + 1}`,
      type: "ai-session",
      source: "session",
      category: "delivery",
      visibility: "local",
      status: i % 4 ? "completed" : "planning",
      tags: [
        topics[i % topics.length]!,
        ...(i % 7 === 0 ? [topics[(i + 1) % topics.length]!] : []),
      ],
      createdAt,
      fields: { createdAt, lastActivity: recent },
    });
    edges.push({
      id: `sample:work:${i}`,
      type: "worked_on_in",
      sourceId: `sample:plan:${i % 200}`,
      targetId: `sample:session:${i}`,
    });
  }
  for (let i = 0; i < 500; i++) {
    const createdAt = now - (i % 40) * day;
    nodes.push({
      id: `sample:commit:${i}`,
      label: `Change ${i + 1}`,
      sublabel: titles[i % titles.length],
      type: "commit",
      source: "git",
      category: "delivery",
      visibility: "local",
      createdAt,
      fields: {
        isoDate: new Date(createdAt).toISOString(),
        subject: titles[i % titles.length],
      },
    });
    edges.push({
      id: `sample:ref:${i}`,
      type: "references",
      sourceId: `sample:plan:${i % 200}`,
      targetId: `sample:commit:${i}`,
    });
  }
  for (let i = 0; i < 200; i++) {
    nodes.push({
      id: `sample:file:${i}`,
      label: `Implementation file ${i + 1}`,
      type: "file",
      source: "file",
      category: "knowledge",
      visibility: "local",
    });
    edges.push({
      id: `sample:touch:${i}`,
      type: "touches",
      sourceId: `sample:commit:${i}`,
      targetId: `sample:file:${i}`,
    });
  }
  for (let i = 0; i < 180; i++)
    nodes.push({
      id: `sample:contact:${i}`,
      label: `Unassigned research record ${i + 1}`,
      type: "custom-research",
      source: "tracker",
      category: "people",
      visibility: "local",
      status: "open",
    });
  const countsByType: Record<string, number> = {};
  for (const n of nodes) countsByType[n.type] = (countsByType[n.type] ?? 0) + 1;
  return {
    generatedAt: now,
    nodes,
    edges,
    stats: { nodeCount: nodes.length, edgeCount: edges.length, countsByType },
  };
}
