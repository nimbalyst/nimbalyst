import * as path from 'path';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type {
  TrackerDataModel,
  TrackerSchemaPatch,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  resolveTrackerSchemaChangeGate,
  validateTrackerTypePredicateDeclarations,
  type PredicateDeclaringType,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';
import { getCurrentIdentity } from '../../services/TrackerIdentityService';
import {
  deleteWorkspaceTrackerSchema,
  ensureWorkspaceTrackerSchemasLoaded,
  getAllTrackerSchemas,
  getTrackerSchemaOwnershipDetails,
  isBuiltinTrackerSchema,
  previewWorkspaceTrackerSchemaChange,
  resetWorkspaceTrackerSchemaOverride,
  type TrackerSchemaOwnershipDetails,
  TrackerTypeExistsError,
  upsertWorkspaceTrackerSchema,
  upsertWorkspaceTrackerSchemaPatch,
  writeThroughTeamTrackerSchemaEdit,
} from '../../services/TrackerSchemaService';
import { applyTrackerSharingChangeToNavigation } from '../../services/TrackerNavigationService';
import { isTrackerSyncActive, syncTrackerItem } from '../../services/TrackerSyncManager';
import { awaitServerIssueKey } from '../../services/tracker/awaitServerIssueKey';
import { TrackerSchemaChangeBlockedError } from '../../services/tracker/trackerSchemaChangeGuard';
import {
  appendTrackerSchemaActivity,
  materializeTrackerTypeDef,
  removeTrackerTypeDef,
} from '../../services/tracker/trackerTypeDefStore';
import { applyPredicateRegistryArgs } from './trackerVocabularyArgs';
import { getDocumentServiceForWorkspace } from './trackerToolItemAccess';
import {
  destructiveSchemaChangeToolResult,
  getAssignedIssueKey,
  type McpToolResult,
} from './trackerToolResult';

type TrackerPromotionResult = {
  publishedCount: number;
  assignedKeyCount: number;
  pendingKeyCount: number;
};

async function publishExistingItemsForTrackerPromotion(
  workspacePath: string,
  trackerType: string,
): Promise<TrackerPromotionResult> {
  const { getDatabase } = await import('../../database/initialize');
  const db = getDatabase();
  const { docService } = await getDocumentServiceForWorkspace(workspacePath);
  if (!docService) {
    throw new Error('No document service is available to promote this tracker. Open the workspace and retry.');
  }

  const items = (await docService.listTrackerItems())
    .filter((item) => item.workspace === workspacePath && item.type === trackerType);
  let publishedCount = 0;
  let assignedKeyCount = 0;
  let pendingKeyCount = 0;

  for (const item of items) {
    try {
      const existingKey = getAssignedIssueKey(item);
      const published = await docService.setTrackerItemPublished(item.id, true);
      const publishedKey = getAssignedIssueKey(published);
      if (existingKey && publishedKey && existingKey !== publishedKey) {
        throw new Error(`Existing issue key changed during tracker promotion: ${existingKey} -> ${publishedKey}`);
      }
      let assignedKey = existingKey ?? publishedKey;

      if (isTrackerSyncActive(workspacePath)) {
        // Promotion owns the backfill explicitly. setTrackerItemPublished also
        // reconciles in the common active-workspace case, but pushing here keeps
        // promotion correct when this workspace's schema is in the scoped cache
        // rather than the registry's currently active layer. The room dedupes by
        // item id and preserves an existing key, so replay cannot consume a
        // second number.
        await syncTrackerItem(published);
        if (!assignedKey) {
          assignedKey = (await awaitServerIssueKey(db, published.id)) ?? undefined;
        }
      } else {
        await db.query(
          `UPDATE tracker_items SET sync_status = 'pending' WHERE id = $1`,
          [published.id],
        );
      }

      if (assignedKey) assignedKeyCount += 1;
      else pendingKeyCount += 1;
      publishedCount += 1;
    } catch (error) {
      const failedItem = getAssignedIssueKey(item) ?? item.id;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Tracker '${trackerType}' is already team-owned, but promotion stopped after ${publishedCount} of ${items.length} items at ${failedItem}: ${reason}. ` +
        `Retry the same Share with team action to finish; completed items keep their ids and issue keys.`,
      );
    }
  }

  // The tracker is the team's now, so its sidebar placement can't stay inside a
  // personal folder — and its navigation row has to re-enter the push lane.
  await applyTrackerSharingChangeToNavigation(workspacePath, trackerType, 'team');

  return {
    publishedCount,
    assignedKeyCount,
    pendingKeyCount,
  };
}

function buildTrackerSchemaFromArgs(args: any): any {
  if (args?.schema && typeof args.schema === 'object' && !Array.isArray(args.schema)) {
    return args.schema;
  }

  const {
    fileName: _fileName,
    overwrite: _overwrite,
    promoteExistingItems: _promoteExistingItems,
    predicates: _predicates,
    removePredicates: _removePredicates,
    ...rest
  } = args ?? {};
  return rest;
}

async function persistAttributedTrackerSchemaEdit(
  workspacePath: string,
  model: TrackerDataModel,
  filePath: string,
): Promise<{ model: TrackerDataModel; ownership?: TrackerSchemaOwnershipDetails }> {
  const attributed = await appendTrackerSchemaActivity(
    workspacePath,
    model,
    getCurrentIdentity(workspacePath),
    'schema_updated',
  );
  if (attributed.sharing === 'team') {
    await writeThroughTeamTrackerSchemaEdit(workspacePath, filePath, attributed);
  } else {
    await materializeTrackerTypeDef(workspacePath, attributed, 'cli');
  }
  const ownership = (await getTrackerSchemaOwnershipDetails(workspacePath, [attributed])).get(attributed.type);
  return { model: attributed, ownership };
}

export async function handleTrackerListTypes(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult> {
  try {
    // Custom (.nimbalyst/trackers/*.yaml) types are loaded into the registry by
    // window/session events; the in-process MCP server can be queried before
    // those fire (or after another window cleared them), so load on demand.
    ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    const includeBuiltin = args?.includeBuiltin !== false;
    const includeCustom = args?.includeCustom !== false;
    const search = typeof args?.search === 'string' ? args.search.trim().toLowerCase() : '';

    const allSchemas = getAllTrackerSchemas();
    const registeredTypes = new Set(allSchemas.map((model) => model.type));
    const items = allSchemas
      // Same rule as `globalRegistry.getListed()`: a type waiting on another is not offered.
      .filter((model) => !model.hiddenUntilType || registeredTypes.has(model.hiddenUntilType))
      .filter((model) => {
        const builtin = isBuiltinTrackerSchema(model.type);
        if (builtin && !includeBuiltin) return false;
        if (!builtin && !includeCustom) return false;
        if (!search) return true;
        return model.type.toLowerCase().includes(search)
          || model.displayName.toLowerCase().includes(search)
          || model.displayNamePlural.toLowerCase().includes(search);
      })
      .sort((a, b) => a.type.localeCompare(b.type));
    const ownershipByType = workspacePath
      ? await getTrackerSchemaOwnershipDetails(workspacePath, items)
      : new Map();

    const structured = {
      action: "listed-types" as const,
      count: items.length,
      items: items.map((model) => ({
        ...model,
        builtin: isBuiltinTrackerSchema(model.type),
        owner: ownershipByType.get(model.type)?.owner
          ?? (model.sharing === 'team'
            ? 'team:your team'
            : isBuiltinTrackerSchema(model.type) ? 'builtin' : 'personal'),
        lastChangedBy: ownershipByType.get(model.type)?.lastChangedBy ?? null,
        activity: ownershipByType.get(model.type)?.activity ?? (model as any).activity ?? [],
        fileName: ownershipByType.get(model.type)?.fileName,
        gitTracked: ownershipByType.get(model.type)?.gitTracked ?? false,
        ownershipNotice: ownershipByType.get(model.type)?.ownershipNotice,
        warning: ownershipByType.get(model.type)?.warning,
      })),
    };

    const summary = items.length > 0
      ? items.map((model) => {
          const builtin = isBuiltinTrackerSchema(model.type) ? 'builtin' : 'custom';
          const ownership = ownershipByType.get(model.type);
          const owner = ownership?.owner
            ?? (model.sharing === 'team' ? 'team:your team' : builtin === 'builtin' ? 'builtin' : 'personal');
          const warning = ownership?.warning ? ` Warning: ${ownership.warning}` : '';
          return `- ${model.type} (${builtin}, ${model.fields.length} fields, owner: ${owner}).${warning}`;
        }).join('\n')
      : 'No tracker types found matching the filters.';

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error listing tracker types: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerDefineType(
  args: any,
  workspacePath: string | undefined,
): Promise<McpToolResult> {
  const vocabularySummaries: string[] = [];
  const result = await defineTrackerType(args, workspacePath, vocabularySummaries);
  if (!result.isError || vocabularySummaries.length === 0) return result;
  // Vocabulary is written before the type is checked, and is not rolled back.
  // Without this the caller sees only the type error, retries, and is told the
  // registry is "unchanged" by a call that never wrote anything.
  const note = `\n\nAlready applied before this error:\n${vocabularySummaries.join('\n')}`;
  return {
    ...result,
    content: result.content.map((part, index) =>
      index === 0 && part.type === 'text' ? { ...part, text: `${part.text ?? ''}${note}` } : part),
  };
}

async function defineTrackerType(
  args: any,
  workspacePath: string | undefined,
  vocabularySummaries: string[],
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return {
        content: [{ type: "text", text: "Error: No workspace path available. Cannot define tracker type." }],
        isError: true,
      };
    }

    // Load existing custom types so a redefine collides with the right file and
    // an agent doesn't think the type is missing (NIM-760).
    ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    // The earlier knowledge graph's label registry is no longer authored here.
    // Refuse rather than ignore, so an older skill sees why nothing changed.
    if (args?.labels !== undefined) {
      return {
        content: [{ type: 'text', text: 'Error: `labels` is no longer supported. Give a page a tracker type and use `predicates` for named relations. An existing .nimbalyst/labels.yaml still loads unchanged.' }],
        isError: true,
      };
    }

    // Vocabulary first: a type declaring `predicate:` on a field needs the verb
    // to exist before the declaration below is checked against the registry.
    let appliedPredicates: PredicateDefinition[] | null = null;
    if (Array.isArray(args?.predicates) || Array.isArray(args?.removePredicates)) {
      const outcome = await applyPredicateRegistryArgs(workspacePath, args);
      if ('error' in outcome) return outcome.error;
      appliedPredicates = outcome.applied;
      vocabularySummaries.push(outcome.summary);
    }
    const vocabularySummary = vocabularySummaries.join('\n');
    // A vocabulary-only call is complete here.
    if (vocabularySummaries.length > 0 && !args?.schema && !args?.patch && typeof args?.type !== 'string') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            structured: {
              action: 'defined-vocabulary' as const,
              ...(appliedPredicates ? { count: appliedPredicates.length, predicates: appliedPredicates } : {}),
            },
            summary: vocabularySummary,
          }),
        }],
        isError: false,
      };
    }

    const requestedDefinition = args?.patch ?? (
      args?.schema && typeof args.schema === 'object' && !Array.isArray(args.schema)
        ? args.schema
        : buildTrackerSchemaFromArgs(args)
    );
    const requestedType = typeof requestedDefinition?.type === 'string'
      ? requestedDefinition.type
      : undefined;
    const requestedSharing = requestedDefinition?.sharing;
    const existingModel = requestedType ? globalRegistry.get(requestedType) : undefined;
    if (existingModel?.sharing === 'team' && requestedSharing === 'personal') {
      return {
        content: [{ type: 'text', text: `Cannot demote team tracker '${requestedType}' to personal. Team tracker promotion is one-way.` }],
        isError: true,
      };
    }
    if (
      existingModel &&
      existingModel.sharing !== 'team' &&
      requestedSharing === 'team' &&
      args?.promoteExistingItems !== true
    ) {
      return {
        content: [{ type: 'text', text: `Promoting personal tracker '${requestedType}' requires promoteExistingItems: true so every existing item is published and receives a server-issued key.` }],
        isError: true,
      };
    }
    if (existingModel && existingModel.sharing !== 'team' && requestedSharing === 'team') {
      const { docService } = await getDocumentServiceForWorkspace(workspacePath);
      if (!docService) {
        return {
          content: [{ type: 'text', text: 'No document service is available to promote this tracker. Open the workspace and retry.' }],
          isError: true,
        };
      }
    }

    // Patch mode: a delta override, the sanctioned path for customizing a
    // built-in (or refining a custom type) without redeclaring the whole schema.
    if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
      const patch = args.patch as TrackerSchemaPatch;
      if (typeof patch.type !== 'string' || patch.type.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Error: patch requires a string 'type'." }],
          isError: true,
        };
      }
      const { model: writtenModel, filePath, backupPath } = await upsertWorkspaceTrackerSchemaPatch(
        workspacePath,
        patch,
        {
          overwrite: args?.overwrite !== false,
          confirmDestructive: args?.confirmDestructive === true,
        },
      );
      const { model, ownership } = await persistAttributedTrackerSchemaEdit(
        workspacePath,
        writtenModel,
        filePath,
      );
      const promotion = args?.promoteExistingItems === true && model.sharing === 'team'
        ? await publishExistingItemsForTrackerPromotion(workspacePath, model.type)
        : undefined;

      const backupNote = backupPath
        ? ` Previous override backed up to ${path.basename(backupPath)}.`
        : '';
      const promotionNote = promotion
        ? ` Published ${promotion.publishedCount} existing item(s); ${promotion.assignedKeyCount} key(s) assigned and ${promotion.pendingKeyCount} awaiting server assignment.`
        : '';
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              structured: {
                action: "defined-type" as const,
                type: model.type,
                model,
                fileName: path.basename(filePath),
                backupFileName: backupPath ? path.basename(backupPath) : undefined,
                mode: "patch" as const,
                promotion,
                ...ownership,
                changeScope: model.sharing === 'team' ? 'team' : 'personal',
              },
              summary: `Applied override patch to tracker type '${model.type}' (.nimbalyst/trackers/${path.basename(filePath)}).${backupNote}${promotionNote}${ownership?.ownershipNotice ? ` ${ownership.ownershipNotice}` : ''}${ownership?.warning ? ` Warning: ${ownership.warning}` : ''}`,
            }),
          },
        ],
        isError: false,
      };
    }

    const schema = buildTrackerSchemaFromArgs(args);
    if (typeof schema.type !== 'string' || schema.type.trim().length === 0) {
      return {
        content: [{ type: "text", text: "Error: tracker_define_type requires a `schema` (custom type) or a `patch` (override)." }],
        isError: true,
      };
    }
    if (isBuiltinTrackerSchema(schema.type)) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot replace built-in tracker type '${schema.type}' with a full schema. Pass a \`patch\` to override it (add/rename status options, tweak fields), or define a new custom type instead.`,
          },
        ],
        isError: true,
      };
    }
    // A field's `predicate:` is checked against the registry HERE, not at the
    // first item write: the defect is in the schema, and reporting it when
    // someone later tries to save an item points the wrong person at the wrong
    // thing. `validate()` still reports the same codes at write time, for a
    // registry that moved after the type was authored.
    const predicateIssues = Array.isArray(schema.fields)
      ? validateTrackerTypePredicateDeclarations(
          schema as PredicateDeclaringType,
          (id) => globalRegistry.getPredicate(id),
          (type) => globalRegistry.get(type)?.extends,
        )
      : [];
    if (predicateIssues.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Error: tracker type '${schema.type}' declares predicates this project does not support.\n${predicateIssues
            .map(issue => `- ${issue.code} at '${issue.path}': ${issue.message}`)
            .join('\n')}`,
        }],
        isError: true,
      };
    }

    const { model: writtenModel, filePath, backupPath } = await upsertWorkspaceTrackerSchema(workspacePath, schema, {
      fileName: args?.fileName,
      overwrite: args?.overwrite === true,
      confirmDestructive: args?.confirmDestructive === true,
    });
    const { model, ownership } = await persistAttributedTrackerSchemaEdit(
      workspacePath,
      writtenModel,
      filePath,
    );
    const promotion = args?.promoteExistingItems === true && model.sharing === 'team'
      ? await publishExistingItemsForTrackerPromotion(workspacePath, model.type)
      : undefined;

    const backupNote = backupPath
      ? ` Existing definition backed up to ${path.basename(backupPath)}.`
      : '';
    const promotionNote = promotion
      ? ` Published ${promotion.publishedCount} existing item(s); ${promotion.assignedKeyCount} key(s) assigned and ${promotion.pendingKeyCount} awaiting server assignment.`
      : '';
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "defined-type" as const,
              type: model.type,
              model,
              fileName: path.basename(filePath),
              backupFileName: backupPath ? path.basename(backupPath) : undefined,
              promotion,
              ...ownership,
              changeScope: model.sharing === 'team' ? 'team' : 'personal',
            },
            summary: `Defined tracker type '${model.type}' in .nimbalyst/trackers/${path.basename(filePath)}.${backupNote}${promotionNote}${ownership?.ownershipNotice ? ` ${ownership.ownershipNotice}` : ''}${ownership?.warning ? ` Warning: ${ownership.warning}` : ''}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    if (error instanceof TrackerSchemaChangeBlockedError) {
      return destructiveSchemaChangeToolResult(error);
    }
    if (error instanceof TrackerTypeExistsError) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Error defining tracker type: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerDeleteType(
  args: any,
  workspacePath: string | undefined,
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return {
        content: [{ type: "text", text: "Error: No workspace path available. Cannot delete tracker type." }],
        isError: true,
      };
    }

    if (typeof args.type !== 'string' || args.type.trim().length === 0) {
      return {
        content: [{ type: "text", text: "Error: tracker_delete_type requires a tracker type." }],
        isError: true,
      };
    }

    ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    const existingModel = globalRegistry.get(args.type);
    const ownership = existingModel
      ? (await getTrackerSchemaOwnershipDetails(workspacePath, [existingModel])).get(args.type)
      : undefined;
    const teamOwned = existingModel?.sharing === 'team';
    const blastRadius = teamOwned ? 'team' as const : 'personal' as const;
    const blastRadiusMessage = teamOwned
      ? `This change updates tracker '${args.type}' for everyone in ${ownership?.owner?.replace(/^team:/, '') || 'your team'}.`
      : `This change only updates your personal tracker '${args.type}'.`;

    if (isBuiltinTrackerSchema(args.type)) {
      // Built-ins can't be deleted, but their workspace override can be reset back
      // to the shipped default (removes the .patch.yaml / full-snapshot override).
      if (args?.resetOverride === true) {
        // Gate BEFORE the attribution write below: a reset on a team tracker
        // pushes a tombstone that resets the type for everyone, and a refused
        // call must not leave an activity entry (or a flipped `source`) behind.
        const confirmed = args?.confirmDestructive === true;
        const decision = await previewWorkspaceTrackerSchemaChange(workspacePath, args.type);
        const verdict = resolveTrackerSchemaChangeGate({
          classification: decision.classification,
          sharing: decision.sharing,
          actorRole: decision.actorRole,
          confirmed,
        });
        if (!verdict.allowed) {
          return destructiveSchemaChangeToolResult(
            new TrackerSchemaChangeBlockedError(args.type, { ...decision, verdict }),
          );
        }
        if (existingModel) {
          const attributed = await appendTrackerSchemaActivity(
            workspacePath,
            existingModel,
            getCurrentIdentity(workspacePath),
            'schema_reset',
          );
          await materializeTrackerTypeDef(workspacePath, attributed, 'cli');
        }
        // resetWorkspaceTrackerSchemaOverride restores the builtin in the registry
        // AND tombstones the mirror row (which propagates the reset to the team).
        const reset = await resetWorkspaceTrackerSchemaOverride(workspacePath, args.type, {
          confirmDestructive: confirmed,
          actorRole: decision.actorRole,
        });
        if (!reset.reset) {
          return {
            content: [{ type: "text", text: `Built-in tracker type '${args.type}' has no workspace override to reset.` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                structured: {
                  action: "reset-override" as const,
                  type: args.type,
                  fileName: reset.filePath ? path.basename(reset.filePath) : undefined,
                  ...ownership,
                  lastChangedBy: getCurrentIdentity(workspacePath).displayName,
                  blastRadius,
                  blastRadiusMessage,
                },
                summary: `Reset built-in tracker type '${args.type}' to its shipped default. ${blastRadiusMessage}`,
              }),
            },
          ],
          isError: false,
        };
      }
      return {
        content: [{ type: "text", text: `Cannot delete built-in tracker type '${args.type}'. Pass resetOverride: true to restore its shipped default instead.` }],
        isError: true,
      };
    }

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();
    // type_tags membership differs by backend: TEXT[] (`= ANY`) on PGLite vs a
    // JSON-string column on SQLite (no ANY()). Branch so delete-type works on
    // both — previously this query threw "no such function: ANY" on SQLite and
    // tracker_delete_type was entirely non-functional there.
    const isSqlite =
      typeof (db as any).getEngine === 'function' && (db as any).getEngine() === 'sqlite';
    const tagMembership = isSqlite
      ? `EXISTS (SELECT 1 FROM json_each(type_tags) WHERE value = $2)`
      : `$2 = ANY(type_tags)`;
    const usage = await db.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count
       FROM tracker_items
       WHERE workspace = $1
         AND (type = $2 OR ${tagMembership})`,
      [workspacePath, args.type]
    );
    const count = Number(usage.rows[0]?.count ?? 0);
    if (count > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Cannot delete tracker type '${args.type}': ${count} tracker item` +
              `${count === 1 ? '' : 's'} still reference this type.`,
          },
        ],
        isError: true,
      };
    }

    const result = await deleteWorkspaceTrackerSchema(workspacePath, args.type);
    if (!result.deleted) {
      return {
        content: [
          {
            type: "text",
            text: `Custom tracker schema not found for type '${args.type}'.`,
          },
        ],
        isError: true,
      };
    }

    if (existingModel) {
      const attributed = await appendTrackerSchemaActivity(
        workspacePath,
        existingModel,
        getCurrentIdentity(workspacePath),
        'schema_deleted',
      );
      await materializeTrackerTypeDef(workspacePath, attributed, 'cli');
    }
    // Tombstone the materialized definition so the CLI stops resolving it.
    await removeTrackerTypeDef(workspacePath, args.type);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "deleted-type" as const,
              type: args.type,
              fileName: result.filePath ? path.basename(result.filePath) : undefined,
              ...ownership,
              lastChangedBy: getCurrentIdentity(workspacePath).displayName,
              blastRadius,
              blastRadiusMessage,
            },
            summary:
              `Deleted tracker type '${args.type}' from .nimbalyst/trackers/` +
              `${result.filePath ? path.basename(result.filePath) : ''}. ${blastRadiusMessage}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    if (error instanceof TrackerSchemaChangeBlockedError) {
      return destructiveSchemaChangeToolResult(error);
    }
    return {
      content: [
        {
          type: "text",
          text: `Error deleting tracker type: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
