import { useMemo, useState } from "react";
import type { ProjectGraphNode } from "../types";
import type { PrototypeModel } from "./contracts";

export function SourceRecord({
  record,
  model,
  sample,
  onClose,
  onOpen,
  onResolve,
  canOpen,
  onOpenOriginal,
}: {
  record: ProjectGraphNode;
  model: PrototypeModel;
  sample: boolean;
  onClose: () => void;
  onOpen: (n: ProjectGraphNode) => void;
  onResolve: (id: string) => void;
  canOpen: boolean;
  onOpenOriginal: () => void;
}) {
  const [tab, setTab] = useState<"record" | "graph" | "history">("record");
  const [limit, setLimit] = useState(12);
  const links = useMemo(
    () =>
      model.snapshot.edges.filter(
        (e) => e.sourceId === record.id || e.targetId === record.id
      ),
    [model, record.id]
  );
  const neighbors = useMemo(
    () =>
      [
        ...new Set(
          links.map((e) => (e.sourceId === record.id ? e.targetId : e.sourceId))
        ),
      ].sort(),
    [links, record.id]
  );
  const events = useMemo(
    () =>
      model.events
        .filter((e) => e.nodeId === record.id)
        .sort((a, b) => b.at - a.at),
    [model, record.id]
  );
  const shown = neighbors.slice(0, limit);
  const navigate = (id: string) => {
    const n = model.nodeById.get(id);
    if (n) {
      onOpen(n);
      setLimit(12);
    } else onResolve(id);
  };
  return (
    <section
      className={`pg-prototype-source ${
        tab === "graph" ? "pg-source-wide" : ""
      }`}
      aria-label="Source record"
    >
      <header>
        <strong>{record.label}</strong>
        <button aria-label="Close source record" onClick={onClose}>
          Close
        </button>
      </header>
      <p>
        {sample
          ? "Illustrative source record"
          : `${record.source} · ${record.type} · ${record.visibility}`}
      </p>
      <nav aria-label="Source exploration">
        {(["record", "graph", "history"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === "record"
              ? "Record"
              : t === "graph"
              ? "Focused graph"
              : "Recorded history"}
          </button>
        ))}
      </nav>
      {tab === "record" ? (
        <>
          <p className="pg-prototype-source-text">
            {record.sublabel ?? String(record.fields?.subject ?? "")}
          </p>
          <code>{record.id}</code>
          <p>
            Current status: {record.status ?? "Not recorded"}
            {record.fields?.archived === true ? " · Archived" : ""}.{" "}
            {model.memberships
              .get(record.id)
              ?.map((m) => m.basis)
              .join(" · ")}
          </p>
          {typeof record.fields?.body === "string" && (
            <details>
              <summary>
                Source body{record.fields?.bodyTruncated ? " · excerpt" : ""}
              </summary>
              <pre>{record.fields.body}</pre>
            </details>
          )}
          {canOpen ? (
            <button onClick={onOpenOriginal}>
              Open original{" "}
              {record.source === "session"
                ? "session"
                : record.source === "tracker"
                ? "tracker"
                : "file"}
            </button>
          ) : (
            <p>
              {sample
                ? "Sample sources do not open real project artifacts."
                : "Original navigation is unavailable for this source; its indexed evidence can be inspected here."}
            </p>
          )}
        </>
      ) : tab === "history" ? (
        <>
          <p>
            Current state is separate from the events below. Gaps do not imply
            continued work or a known past state. Archive is independent of
            completion.
          </p>
          <strong>
            Now: {record.status ?? "status not recorded"}
            {record.fields?.archived === true ? " · archived" : ""}
          </strong>
          {events.length ? (
            <ol>
              {events.map((e) => (
                <li key={e.id}>
                  <time>{new Date(e.at).toLocaleString()}</time> — {e.label}{" "}
                  <small>
                    (
                    {e.provenance === "recorded"
                      ? "recorded event"
                      : "last observed only"}
                    )
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p>
              No dated events are available for this record in the loaded source
              history.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            {shown.length} of {neighbors.length} neighboring records ·{" "}
            {links.length} connections in the loaded snapshot. Arrows preserve
            source direction. Select a record to recenter.
          </p>
          {shown.length > 0 ? (
            <svg
              role="group"
              aria-label="Focused connection graph"
              viewBox={`0 0 640 ${Math.max(180, shown.length * 66)}`}
            >
              <defs>
                <marker
                  id="pg-source-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                </marker>
              </defs>
              <rect
                x="8"
                y={Math.max(180, shown.length * 66) / 2 - 26}
                width="192"
                height="52"
                rx="6"
                className="pg-source-graph-focus"
              />
              <text x="18" y={Math.max(180, shown.length * 66) / 2 + 4}>
                {record.label.slice(0, 25)}
              </text>
              {shown.map((id, i) => {
                const n = model.nodeById.get(id);
                const related = links.filter(
                  (e) => e.sourceId === id || e.targetId === id
                );
                const incoming = related.some((e) => e.targetId === record.id);
                const outgoing = related.some((e) => e.sourceId === record.id);
                const y = i * 66 + 32;
                return (
                  <g key={id}>
                    <path
                      d={`M200,${Math.max(180, shown.length * 66) / 2} C255,${
                        Math.max(180, shown.length * 66) / 2
                      } 270,${y} 335,${y}`}
                      fill="none"
                      stroke="currentColor"
                      markerStart={
                        incoming ? "url(#pg-source-arrow)" : undefined
                      }
                      markerEnd={outgoing ? "url(#pg-source-arrow)" : undefined}
                    />
                    <g
                      role="button"
                      aria-label={`Explore ${n?.label ?? id}`}
                      tabIndex={0}
                      onClick={() => navigate(id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(id);
                        }
                      }}
                      className="pg-source-graph-node"
                    >
                      <rect x="340" y={y - 23} width="292" height="48" rx="5" />
                      <text x="350" y={y - 2}>
                        {(n?.label ?? id).slice(0, 39)}
                      </text>
                      <text
                        x="350"
                        y={y + 15}
                        className="pg-source-graph-caption"
                      >
                        {n
                          ? `${related.length} ${
                              related.length === 1
                                ? "connection"
                                : "connections"
                            }`
                          : "Unresolved · try loading source"}
                      </text>
                      <title>{n?.label ?? id}</title>
                    </g>
                  </g>
                );
              })}
            </svg>
          ) : (
            <p>
              No connections available in the loaded snapshot. This does not
              establish that the source has no links.
            </p>
          )}
          {shown.length < neighbors.length && (
            <button
              onClick={() => setLimit((v) => Math.min(v + 12, 60))}
              disabled={limit >= 60}
            >
              {limit >= 60
                ? "60-neighbor display limit; use Evidence Trails to explore further"
                : "Show 12 more neighbors"}
            </button>
          )}
          <ul>
            {links
              .filter((e) =>
                shown.includes(
                  e.sourceId === record.id ? e.targetId : e.sourceId
                )
              )
              .slice(0, 120)
              .map((e) => (
                <li key={e.id}>
                  <strong>{e.type}</strong>:{" "}
                  {model.nodeById.get(e.sourceId)?.label ?? e.sourceId} →{" "}
                  {model.nodeById.get(e.targetId)?.label ?? e.targetId}
                  <br />
                  <small>
                    {e.provenance?.kind ?? "unknown"} —{" "}
                    {e.provenance?.basis ??
                      "The source did not declare this relationship’s basis."}
                  </small>
                </li>
              ))}
          </ul>
          {links.filter((e) =>
            shown.includes(e.sourceId === record.id ? e.targetId : e.sourceId)
          ).length > 120 && (
            <p>
              Showing the first 120 relationship details for the displayed
              neighbors.
            </p>
          )}
        </>
      )}
    </section>
  );
}
