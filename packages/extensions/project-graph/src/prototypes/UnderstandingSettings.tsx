import { useState } from "react";
import type { ViewSettings, ViewLens } from "./viewSettings";
import { SOURCES, lensMatches } from "./viewSettings";
import type { ProjectIndexState } from "../indexing/projectIndex";
import type { AreaRule } from "./areaRegistry";
import { addAreaRule } from "./areaRegistry";
import type { ProjectGraphNode } from "../types";

export function UnderstandingSettings({
  value,
  onChange,
  index,
  registry,
  onRegistry,
  nodes,
  onClose,
}: {
  value: ViewSettings;
  onChange: (s: ViewSettings) => void;
  index: ProjectIndexState;
  registry: AreaRule[];
  onRegistry: (r: AreaRule[]) => void;
  nodes: ProjectGraphNode[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"tag" | "path" | "anchor">("tag");
  const [rule, setRule] = useState("");
  const [lensName, setLensName] = useState("");
  const [anchorSearch, setAnchorSearch] = useState("");
  const types = [...new Set(nodes.map((n) => n.type))].sort();
  const anchors = nodes
    .filter((n) => n.label.toLowerCase().includes(anchorSearch.toLowerCase()))
    .slice(0, 40);
  const saveLens = () => {
    if (!lensName.trim()) return;
    const l: ViewLens = {
      id: `lens:${Date.now()}`,
      name: lensName.trim().slice(0, 80),
      mode: draft.mode,
      days: draft.days,
      areaId: draft.areaId,
      excludedTypes: draft.excludedTypes,
      compare: draft.compare,
    };
    const next = { ...draft, lenses: [...draft.lenses, l], lensId: l.id };
    setDraft(next);
    setLensName("");
  };
  return (
    <section
      className="pg-understanding-settings"
      aria-label="Project view settings"
    >
      <header>
        <h2>Project view settings</h2>
        <button onClick={onClose}>Close settings</button>
      </header>
      <div className="pg-settings-columns">
        <section>
          <h3>Indexed sources</h3>
          <p>
            Index lightweight records across each enabled source. Bodies load
            when opened. Earlier view windows request additional event evidence;
            viewing dates do not remove older contextual records.
          </p>
          {SOURCES.map(({ id, label }) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={draft.sources[id] !== false}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    sources: { ...draft.sources, [id]: e.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={draft.includeArchived}
              onChange={(e) =>
                setDraft({ ...draft, includeArchived: e.target.checked })
              }
            />
            Include archived records
          </label>
          <label>
            Event history{" "}
            <select
              value={draft.historyDays ?? "all"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  historyDays:
                    e.target.value === "all" ? null : Number(e.target.value),
                })
              }
            >
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
              <option value="all">All available</option>
            </select>
          </label>
          <details>
            <summary>Advanced loading</summary>
            <p>
              Batch size adapts to measured query latency. Limits below
              deliberately truncate source coverage.
            </p>
            <label>
              Safety limit per source{" "}
              <select
                value={draft.safetyLimit ?? "none"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    safetyLimit:
                      e.target.value === "none" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="none">No record limit</option>
                <option value={10000}>10,000</option>
                <option value={50000}>50,000</option>
                <option value={100000}>100,000</option>
              </select>
            </label>
            <ul>
              {SOURCES.map(({ id, label }) => (
                <li key={id}>
                  {label}: {Math.round(index.timings[id]?.totalMs ?? 0)} ms ·{" "}
                  {index.timings[id]?.pages ?? 0} pages · slowest{" "}
                  {Math.round(index.timings[id]?.slowestPageMs ?? 0)} ms
                </li>
              ))}
            </ul>
          </details>
        </section>
        <section>
          <h3>View filters & saved lenses</h3>
          <p>
            Filters change displayed evidence and counts. The index and area
            positions remain intact.
          </p>
          <div className="pg-settings-type-list">
            {types.map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={!draft.excludedTypes.includes(type)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      excludedTypes: e.target.checked
                        ? draft.excludedTypes.filter((t) => t !== type)
                        : [...draft.excludedTypes, type],
                    })
                  }
                />
                {type}
              </label>
            ))}
          </div>
          <label>
            Lens name{" "}
            <input
              value={lensName}
              onChange={(e) => setLensName(e.target.value)}
              placeholder="My project lens"
            />
          </label>
          <button
            disabled={!lensName.trim() || draft.lenses.length >= 30}
            onClick={saveLens}
          >
            Save current lens
          </button>
          <ul>
            {draft.lenses.map((l) => (
              <li key={l.id}>
                {l.name}
                {lensMatches(draft, l) ? " · current" : ""}{" "}
                <button
                  aria-label={`Remove lens ${l.name}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      lenses: draft.lenses.filter((x) => x.id !== l.id),
                      lensId: draft.lensId === l.id ? null : draft.lensId,
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Stable areas</h3>
          <p>
            Initial topics are seeded once. Refresh never promotes new tags or
            moves existing areas. Edit rules here; hidden areas keep their
            position.
          </p>
          <ul className="pg-area-rule-list">
            {registry.map((r) => (
              <li key={r.id}>
                <label>
                  <input
                    aria-label={`Show area ${r.label}`}
                    type="checkbox"
                    disabled={r.id === "unassigned"}
                    checked={!r.hidden}
                    onChange={(e) =>
                      onRegistry(
                        registry.map((x) =>
                          x.id === r.id
                            ? { ...x, hidden: !e.target.checked }
                            : x
                        )
                      )
                    }
                  />
                  <input
                    aria-label={`Area name ${r.label}`}
                    value={r.label}
                    onChange={(e) =>
                      onRegistry(
                        registry.map((x) =>
                          x.id === r.id ? { ...x, label: e.target.value } : x
                        )
                      )
                    }
                  />
                </label>
                <small>
                  {[
                    ...(r.tags ?? []).map((t) => `tag: ${t}`),
                    ...(r.paths ?? []).map((p) => `path: ${p}`),
                    ...(r.anchorIds ?? []).map(
                      (id) => nodes.find((n) => n.id === id)?.label ?? id
                    ),
                  ].join(" · ") || "Outside configured areas"}
                </small>
                {r.id !== "unassigned" && (
                  <details>
                    <summary>Edit membership rules</summary>
                    <label>
                      Tags (comma separated)
                      <input
                        defaultValue={r.tags?.join(", ") ?? ""}
                        onBlur={(e) =>
                          onRegistry(
                            registry.map((x) =>
                              x.id === r.id
                                ? {
                                    ...x,
                                    tags: e.target.value
                                      .split(",")
                                      .map((t) => t.trim().toLowerCase())
                                      .filter(Boolean),
                                  }
                                : x
                            )
                          )
                        }
                      />
                    </label>
                    <label>
                      Paths (comma separated)
                      <input
                        defaultValue={r.paths?.join(", ") ?? ""}
                        onBlur={(e) =>
                          onRegistry(
                            registry.map((x) =>
                              x.id === r.id
                                ? {
                                    ...x,
                                    paths: e.target.value
                                      .split(",")
                                      .map((t) => t.trim().replace(/\/+$/, ""))
                                      .filter(Boolean),
                                  }
                                : x
                            )
                          )
                        }
                      />
                    </label>
                    {r.anchorIds?.map((id) => (
                      <button
                        key={id}
                        onClick={() =>
                          onRegistry(
                            registry.map((x) =>
                              x.id === r.id
                                ? {
                                    ...x,
                                    anchorIds: x.anchorIds?.filter(
                                      (a) => a !== id
                                    ),
                                  }
                                : x
                            )
                          )
                        }
                      >
                        Remove anchor{" "}
                        {nodes.find((n) => n.id === id)?.label ?? id}
                      </button>
                    ))}
                  </details>
                )}
              </li>
            ))}
          </ul>
          <label>
            New area name{" "}
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Membership rule{" "}
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setRule("");
              }}
            >
              <option value="tag">Topic tag</option>
              <option value="path">Path prefix</option>
              <option value="anchor">Record and its direct neighbors</option>
            </select>
          </label>
          {kind === "anchor" ? (
            <>
              <label>
                Find anchor{" "}
                <input
                  value={anchorSearch}
                  onChange={(e) => setAnchorSearch(e.target.value)}
                />
              </label>
              <label>
                Anchor record{" "}
                <select value={rule} onChange={(e) => setRule(e.target.value)}>
                  <option value="">Select record…</option>
                  {anchors.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label} · {n.type}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                Showing up to 40 matching records. Search to narrow.
              </small>
            </>
          ) : (
            <label>
              {kind === "tag" ? "Topic tag" : "Path prefix"}
              <input value={rule} onChange={(e) => setRule(e.target.value)} />
            </label>
          )}
          <button
            disabled={!label.trim() || !rule.trim() || registry.length >= 200}
            onClick={() => {
              onRegistry(
                addAreaRule(registry, {
                  id: `area:${Date.now()}`,
                  label: label.trim().slice(0, 80),
                  ...(kind === "tag"
                    ? { tags: [rule.trim().toLowerCase()] }
                    : kind === "path"
                    ? { paths: [rule.trim().replace(/\/+$/, "")] }
                    : { anchorIds: [rule] }),
                })
              );
              setLabel("");
              setRule("");
            }}
          >
            Add area
          </button>
          <p>
            Area edits save immediately. Source records and tags are never
            rewritten.
          </p>
        </section>
      </div>
      <footer>
        <button
          onClick={() => {
            onChange(draft);
            onClose();
          }}
        >
          Apply settings
        </button>
        <span>
          Source and history changes refresh the index; view filters reuse it.
        </span>
      </footer>
    </section>
  );
}
