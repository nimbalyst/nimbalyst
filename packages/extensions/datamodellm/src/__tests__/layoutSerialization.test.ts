// @vitest-environment node
import { expect, it } from 'vitest';
import { parsePrismaSchema } from '../prismaParser';
import { createLayoutSerializer } from '../layout/serialization';

it('preserves schema bytes through layout, view changes and reload, while retaining semantic edits', () => {
  const source =
    '// Keep this comment and formatting\nmodel Parent {\n  id String @id\n  children Child[]\n}\n\nmodel Child {\n  id String @id\n  parentId String\n  parent Parent @relation(fields: [parentId], references: [id])\n}\n';
  const serializer = createLayoutSerializer();
  const model = parsePrismaSchema(source);
  serializer.capture(source, model);
  const moved = {
    ...model,
    entities: model.entities.map((e, i) => ({
      ...e,
      position: { x: i * 400, y: 50 },
    })),
    entityViewMode: 'full' as const,
  };
  const saved = serializer.serialize(moved);
  expect(saved.substring(saved.indexOf('\n') + 1)).toBe(source);
  const reopened = parsePrismaSchema(saved);
  expect(reopened.entities.map((e) => e.position)).toEqual(
    moved.entities.map((e) => e.position)
  );
  serializer.capture(saved, reopened);
  expect(
    serializer
      .serialize({ ...reopened, viewport: { x: 10, y: 20, zoom: 0.8 } })
      .substring(saved.indexOf('\n') + 1)
  ).toContain('Keep this comment');
  const renamed = {
    ...moved,
    entities: moved.entities.map((e) => ({ ...e, name: e.name + 'Changed' })),
  };
  expect(serializer.serialize(renamed)).toContain('model ParentChanged');
});
