import { useMemo } from 'react';
import type {
  GraphNodeTypeSchema,
  ProjectGraphEdge,
  ProjectGraphNode,
  ProjectGraphSnapshot,
} from '../types';
import { getTypeSchema } from '../schema';
import { IconFile, IconLaunch, IconPlay, IconPlus, IconShare } from './icons';

interface GraphInspectorProps {
  snapshot: ProjectGraphSnapshot;
  types: GraphNodeTypeSchema[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onAction: (action: string, node: ProjectGraphNode) => void;
}

interface IncomingRelation {
  edge: ProjectGraphEdge;
  other: ProjectGraphNode;
  otherSchema: GraphNodeTypeSchema | undefined;
  direction: 'outgoing' | 'incoming';
}

function statusPillClass(status?: string): string {
  if (!status) return 'pg-pill';
  if (/shipped|done|closed|complete/i.test(status)) return 'pg-pill is-status-done';
  if (/open|in-progress|active|in-review|draft/i.test(status)) return 'pg-pill is-status-open';
  return 'pg-pill';
}

export function GraphInspector({ snapshot, types, selectedNodeId, onSelectNode, onAction }: GraphInspectorProps) {
  const node = useMemo(() => {
    if (!selectedNodeId) return null;
    return snapshot.nodes.find(n => n.id === selectedNodeId) ?? null;
  }, [snapshot.nodes, selectedNodeId]);

  // Fall back to a synthetic schema for custom tracker types (idea, blog, …)
  // that have no built-in entry. Without this the inspector would show its empty
  // state for any non-built-in node selected from the timeline or graph.
  const schema = node
    ? getTypeSchema(types, node.type) ?? {
        type: node.type,
        label: node.type,
        category: node.category,
        colorToken: '--pg-c-file',
        shape: 'pill' as const,
        quickActions: [],
      }
    : undefined;

  const relations = useMemo<IncomingRelation[]>(() => {
    if (!node) return [];
    const items: IncomingRelation[] = [];
    for (const edge of snapshot.edges) {
      if (edge.sourceId === node.id) {
        const other = snapshot.nodes.find(n => n.id === edge.targetId);
        if (other) items.push({ edge, other, otherSchema: getTypeSchema(types, other.type), direction: 'outgoing' });
      } else if (edge.targetId === node.id) {
        const other = snapshot.nodes.find(n => n.id === edge.sourceId);
        if (other) items.push({ edge, other, otherSchema: getTypeSchema(types, other.type), direction: 'incoming' });
      }
    }
    return items;
  }, [node, snapshot.nodes, snapshot.edges, types]);

  if (!node || !schema) {
    return (
      <aside className="pg-inspector">
        <div className="pg-empty">Select a node to see its details, relations, and actions.</div>
      </aside>
    );
  }

  const accent = `var(${schema.colorToken})`;
  const owner = typeof node.fields?.owner === 'string' ? node.fields.owner : undefined;
  const path = typeof node.fields?.path === 'string' ? node.fields.path : undefined;

  return (
    <aside className="pg-inspector">
      <div className="pg-insp-header">
        <div className="pg-insp-type" style={{ color: accent }}>
          <span className="pg-dot" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
          {schema.label}
        </div>
        <div className="pg-insp-title">{path ?? node.label}</div>
        <div className="pg-insp-id">{node.id} · src={node.source} · {node.visibility}</div>
      </div>

      <div className="pg-insp-meta">
        {owner && (
          <div>
            <div className="pg-k">Owner</div>
            <div className="pg-v"><span className="pg-pill">{owner}</span></div>
          </div>
        )}
        {node.status && (
          <div>
            <div className="pg-k">Status</div>
            <div className="pg-v"><span className={statusPillClass(node.status)}>{node.status}</span></div>
          </div>
        )}
        {node.priority && (
          <div>
            <div className="pg-k">Priority</div>
            <div className="pg-v"><span className="pg-pill">{node.priority}</span></div>
          </div>
        )}
        {node.severity && (
          <div>
            <div className="pg-k">Severity</div>
            <div className="pg-v"><span className="pg-pill is-severity">{node.severity}</span></div>
          </div>
        )}
        {typeof node.progress === 'number' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="pg-k">Progress</div>
            <div className="pg-v" style={{ display: 'block' }}>
              <div className="pg-progress">
                <span style={{ width: `${Math.max(0, Math.min(100, node.progress))}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="pg-insp-actions">
        {schema.quickActions?.includes('launch-fix-session') && (
          <button className="pg-insp-action is-primary" onClick={() => onAction('launch-fix-session', node)}>
            <IconPlay /> Launch fix session
          </button>
        )}
        {schema.quickActions?.includes('launch-session') && (
          <button className="pg-insp-action is-primary" onClick={() => onAction('launch-session', node)}>
            <IconPlay /> Launch session
          </button>
        )}
        {schema.quickActions?.includes('open-file') && (
          <button className="pg-insp-action" onClick={() => onAction('open-file', node)}>
            <IconFile /> Open file
          </button>
        )}
        {schema.quickActions?.includes('reveal-in-tracker') && (
          <button className="pg-insp-action" onClick={() => onAction('reveal-in-tracker', node)}>
            <IconShare /> Reveal in tracker
          </button>
        )}
        {schema.quickActions?.includes('add-bug') && (
          <button className="pg-insp-action" onClick={() => onAction('add-bug', node)}>
            <IconPlus /> Add bug
          </button>
        )}
        {schema.quickActions?.includes('add-task') && (
          <button className="pg-insp-action" onClick={() => onAction('add-task', node)}>
            <IconPlus /> Add task
          </button>
        )}
        {schema.quickActions?.includes('add-feature') && (
          <button className="pg-insp-action" onClick={() => onAction('add-feature', node)}>
            <IconPlus /> Add feature
          </button>
        )}
        {schema.quickActions?.includes('open') && (
          <button className="pg-insp-action" onClick={() => onAction('open', node)}>
            <IconLaunch /> Open
          </button>
        )}
      </div>

      <div className="pg-insp-section">
        <h4>
          Relations <span className="pg-count">{relations.length}</span>
        </h4>
        {relations.length === 0 ? (
          <div style={{ color: 'var(--pg-text-mute)', fontSize: 11.5 }}>No connected nodes.</div>
        ) : (
          relations.map(rel => (
            <button
              key={rel.edge.id}
              type="button"
              className="pg-relation"
              onClick={() => onSelectNode(rel.other.id)}
              title={`${rel.direction === 'outgoing' ? rel.edge.type : `${rel.edge.type} (in)`}`}
            >
              <span
                className="pg-rt-dot"
                style={{ background: rel.otherSchema ? `var(${rel.otherSchema.colorToken})` : '#9aa3b6' }}
              />
              <span className="pg-rt-label">{rel.other.label}</span>
              <span className="pg-rt-edge">{rel.edge.type}</span>
            </button>
          ))
        )}
      </div>

      {node.counts && Object.keys(node.counts).length > 0 && (
        <div className="pg-insp-section">
          <h4>Rollups</h4>
          {Object.entries(node.counts).map(([k, v]) => (
            <div key={k} className="pg-progress-row">
              <span className="pg-label">{k}</span>
              <span className="pg-val">{v}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
