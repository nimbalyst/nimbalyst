import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrackerDataModelRegistry,
  getRoleField,
  getFieldByRole,
  type TrackerDataModel,
  type TrackerSchemaRole,
} from '../TrackerDataModel';
import { parseTrackerYAML } from '../YAMLParser';

function makeBugModel(): TrackerDataModel {
  return {
    type: 'bug',
    displayName: 'Bug',
    displayNamePlural: 'Bugs',
    icon: 'bug_report',
    color: '#dc2626',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'bug',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      {
        name: 'state',
        type: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ],
      },
      {
        name: 'severity',
        type: 'select',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'critical', label: 'Critical' },
        ],
      },
      { name: 'assignedTo', type: 'user' },
      { name: 'labels', type: 'array', itemType: 'string' },
    ],
    roles: {
      title: 'title',
      workflowStatus: 'state',
      priority: 'severity',
      assignee: 'assignedTo',
      tags: 'labels',
    },
  };
}

describe('getRoleField', () => {
  it('returns the field name for a declared role', () => {
    const model = makeBugModel();
    expect(getRoleField(model, 'workflowStatus')).toBe('state');
    expect(getRoleField(model, 'priority')).toBe('severity');
    expect(getRoleField(model, 'assignee')).toBe('assignedTo');
    expect(getRoleField(model, 'tags')).toBe('labels');
    expect(getRoleField(model, 'title')).toBe('title');
  });

  it('returns undefined for undeclared roles', () => {
    const model = makeBugModel();
    expect(getRoleField(model, 'dueDate')).toBeUndefined();
    expect(getRoleField(model, 'progress')).toBeUndefined();
    expect(getRoleField(model, 'reporter')).toBeUndefined();
  });

  it('returns undefined when model has no roles', () => {
    const model = makeBugModel();
    delete model.roles;
    expect(getRoleField(model, 'title')).toBeUndefined();
  });
});

describe('getFieldByRole', () => {
  let registry: TrackerDataModelRegistry;

  beforeEach(() => {
    registry = new TrackerDataModelRegistry();
    registry.register(makeBugModel());
  });

  it('returns the FieldDefinition for a declared role', () => {
    const field = getFieldByRole(registry, 'bug', 'workflowStatus');
    expect(field).toBeDefined();
    expect(field!.name).toBe('state');
    expect(field!.type).toBe('select');
    expect(field!.options).toHaveLength(2);
  });

  it('returns undefined for unknown type', () => {
    expect(getFieldByRole(registry, 'nonexistent', 'title')).toBeUndefined();
  });

  it('returns undefined for undeclared role', () => {
    expect(getFieldByRole(registry, 'bug', 'dueDate')).toBeUndefined();
  });

  it('returns undefined when role field name does not match any field', () => {
    const model = makeBugModel();
    model.roles!.dueDate = 'nonexistentField';
    registry.register(model);
    expect(getFieldByRole(registry, 'bug', 'dueDate')).toBeUndefined();
  });
});

describe('TrackerDataModelRegistry workspace overrides', () => {
  it('restores a built-in model after clearing workspace overrides', () => {
    const registry = new TrackerDataModelRegistry();
    const builtin = makeBugModel();
    registry.register(builtin, true);

    const override = {
      ...makeBugModel(),
      displayName: 'Bug Override',
      fields: [
        ...makeBugModel().fields,
        { name: 'customerImpact', type: 'string' as const },
      ],
    };
    registry.register(override);

    expect(registry.isBuiltin('bug')).toBe(true);
    expect(registry.get('bug')?.displayName).toBe('Bug Override');

    registry.clearWorkspaceSchemas();

    expect(registry.isBuiltin('bug')).toBe(true);
    expect(registry.get('bug')?.displayName).toBe('Bug');
    expect(registry.get('bug')?.fields.some((f) => f.name === 'customerImpact')).toBe(false);
  });

  it('clears one workspace schema and restores a built-in override', () => {
    const registry = new TrackerDataModelRegistry();
    const builtin = makeBugModel();
    registry.register(builtin, true);
    registry.register({ ...makeBugModel(), displayName: 'Bug Override' });
    registry.register({
      type: 'epic',
      displayName: 'Epic',
      fields: [{ name: 'title', type: 'string', required: true }],
    } as TrackerDataModel);

    expect(registry.clearWorkspaceSchema('epic')).toBe(true);
    expect(registry.get('epic')).toBeUndefined();

    expect(registry.clearWorkspaceSchema('bug')).toBe(true);
    expect(registry.get('bug')?.displayName).toBe('Bug');
    expect(registry.isBuiltin('bug')).toBe(true);
  });
});

describe('YAML parser roles', () => {
  it('parses roles from YAML', () => {
    const yaml = `
type: sprint
displayName: Sprint
displayNamePlural: Sprints
icon: sprint
color: "#22c55e"
modes:
  inline: true
  fullDocument: false
idPrefix: spr
fields:
  - name: name
    type: string
    required: true
  - name: phase
    type: select
    options:
      - value: planning
        label: Planning
      - value: active
        label: Active
      - value: done
        label: Done
  - name: lead
    type: user
roles:
  title: name
  workflowStatus: phase
  assignee: lead
`;
    const model = parseTrackerYAML(yaml);
    expect(model.roles).toBeDefined();
    expect(model.roles!.title).toBe('name');
    expect(model.roles!.workflowStatus).toBe('phase');
    expect(model.roles!.assignee).toBe('lead');
    expect(model.roles!.priority).toBeUndefined();
  });

  it('ignores invalid role keys', () => {
    const yaml = `
type: test
displayName: Test
displayNamePlural: Tests
icon: test
color: "#000"
modes:
  inline: true
idPrefix: tst
fields:
  - name: title
    type: string
    required: true
roles:
  title: title
  invalidRole: someField
`;
    const model = parseTrackerYAML(yaml);
    expect(model.roles).toBeDefined();
    expect(model.roles!.title).toBe('title');
    expect((model.roles as any).invalidRole).toBeUndefined();
  });

  it('omits roles when not present in YAML', () => {
    const yaml = `
type: minimal
displayName: Minimal
displayNamePlural: Minimals
icon: circle
color: "#999"
modes:
  inline: true
idPrefix: min
fields:
  - name: title
    type: string
    required: true
`;
    const model = parseTrackerYAML(yaml);
    expect(model.roles).toBeUndefined();
  });
});
