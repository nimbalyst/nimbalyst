/**
 * TrackerDocumentHeader - the type row of a typed markdown file.
 *
 * A file with tracker frontmatter (a plan, a decision, ...) is a typed page
 * that lives in Files. It draws the same row a typed page in Pages draws
 * (`TrackerTypeRow`): the type chip, the fields that hold a value, and a "+"
 * for the rest, with the file's tracker item key at the end. Edits round-trip
 * through the frontmatter.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { FieldDefinition } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { TrackerTypeRow } from '../components/TrackerTypeRow';
import { useTrackerChipFieldSections } from '../components/trackerChipFields';
import { useTrackerRelationshipCandidates } from '../components/useTrackerRelationshipCandidates';
import type { TeamMemberOption } from '../components/TrackerFieldEditor';
import { ModelLoader } from '../models/ModelLoader';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsMapAtom } from '../trackerDataAtoms';
import { getRecordTitle } from '../trackerRecordAccessors';
import { navigateToTrackerReference } from '../../TrackerLinkPlugin/trackerReferenceData';
import { detectTrackerFromFrontmatter, updateTrackerInFrontmatter } from './frontmatterUtils';
import { FrontmatterWriteError } from './frontmatterSource';
import { detectFlatTypedPage, updateFlatTypedPageFields } from './flatTypedPage';
import type { DocumentHeaderComponentProps } from './DocumentHeaderRegistry';

function normalizeDocumentPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Find the frontmatter tracker record projected from the open document. */
export function findAssociatedTrackerItem(
  items: Iterable<TrackerRecord>,
  filePath: string,
  trackerType: string,
): TrackerRecord | null {
  const normalizedFilePath = normalizeDocumentPath(filePath);

  for (const item of items) {
    if (item.source !== 'frontmatter' || item.primaryType !== trackerType) continue;
    const documentPath = item.system.documentPath;
    if (!documentPath) continue;

    const normalizedDocumentPath = normalizeDocumentPath(documentPath);
    if (normalizedDocumentPath === normalizedFilePath) return item;

    const workspace = normalizeDocumentPath(item.system.workspace || '');
    if (workspace && `${workspace}/${normalizedDocumentPath}` === normalizedFilePath) {
      return item;
    }
  }

  return null;
}

export const TrackerDocumentHeader: React.FC<DocumentHeaderComponentProps> = ({
  filePath,
  fileName,
  getContent,
  contentVersion,
  onContentChange,
  editor,
  trackerFieldCapabilities,
}) => {
  const [dataModel, setDataModel] = useState<TrackerDataModel | null>(null);
  const [trackerType, setTrackerType] = useState<string | null>(null);
  const trackerItems = useAtomValue(trackerItemsMapAtom);
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);
  /** Set when the frontmatter writer refused the last edit; cleared by the next one. */
  const [writeError, setWriteError] = useState<string | null>(null);
  const { chipFields } = useTrackerChipFieldSections(dataModel?.type ?? '');

  // Get fresh tracker data when contentVersion changes. A Local wiki page
  // keeps its type and fields flat at the top of the frontmatter.
  const trackerData = useMemo(() => {
    const content = getContent();
    const wrapped = detectTrackerFromFrontmatter(content);
    if (wrapped) return { ...wrapped, flatId: undefined };
    const flat = detectFlatTypedPage(content, filePath);
    return flat ? { type: flat.type, data: flat.data, flatId: flat.id } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getContent, contentVersion, filePath]);

  // Load data model when tracker type changes (or on mount)
  useEffect(() => {
    const currentType = trackerData?.type ?? null;

    // Only reload model if type changed
    if (currentType === trackerType) return;
    setTrackerType(currentType);

    if (currentType) {
      const loadModel = async () => {
        try {
          const loader = ModelLoader.getInstance();
          const model = await loader.getModel(currentType);
          setDataModel(model);
        } catch (error) {
          console.error(`[TrackerDocumentHeader] Failed to load model for type "${currentType}":`, error);
          setDataModel(null);
        }
      };
      loadModel();
    } else {
      setDataModel(null);
    }
  }, [trackerData?.type, trackerType]);

  // The row shows an edit at once; the file's next read confirms it.
  const [localData, setLocalData] = useState<Record<string, unknown>>(trackerData?.data ?? {});
  useEffect(() => setLocalData(trackerData?.data ?? {}), [trackerData]);

  // Handle field changes - get fresh content at the moment of change
  const handleChange = useCallback((updates: Record<string, any>) => {
    if (!trackerData || !onContentChange) return;

    // Get fresh content and update with new frontmatter
    const currentContent = getContent();
    let updatedContent: string;
    try {
      updatedContent = trackerData.flatId !== undefined
        ? updateFlatTypedPageFields(currentContent, updates)
        : updateTrackerInFrontmatter(currentContent, trackerData.type, updates);
    } catch (error) {
      // The writer refuses a header it cannot rewrite without losing the
      // author's YAML (#1552). Say so and leave the document alone -- silently
      // dropping the edit just makes the field snap back with no explanation.
      if (error instanceof FrontmatterWriteError) {
        setWriteError(error.message);
        return;
      }
      throw error;
    }
    setWriteError(null);
    setLocalData((current) => ({ ...current, ...updates }));
    onContentChange(updatedContent);
  }, [getContent, trackerData, onContentChange]);
  const handleSaveField = useCallback(
    (field: FieldDefinition, value: unknown) => handleChange({ [field.name]: value }),
    [handleChange],
  );

  const associatedItem = useMemo(() => {
    if (!trackerData) return null;
    // A Local wiki page is its own record, under the id in its frontmatter.
    if (trackerData.flatId !== undefined) return trackerData.flatId ? trackerItems.get(trackerData.flatId) ?? null : null;
    return findAssociatedTrackerItem(trackerItems.values(), filePath, trackerData.type);
  }, [filePath, trackerData, trackerItems]);
  const relationshipCandidates = useTrackerRelationshipCandidates(associatedItem, chipFields);

  useEffect(() => {
    const loadTeamMembers = trackerFieldCapabilities?.loadTeamMembers;
    if (!loadTeamMembers || !trackerData) {
      setTeamMembers([]);
      return;
    }
    let cancelled = false;
    void loadTeamMembers()
      .then((members) => {
        if (!cancelled) setTeamMembers(members);
      })
      .catch(() => {
        if (!cancelled) setTeamMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trackerData?.type, trackerFieldCapabilities?.loadTeamMembers]);

  const handleOpenItem = useCallback((itemId: string) => {
    const related = trackerItems.get(itemId);
    if (!related) return;
    const title = getRecordTitle(related) || related.issueKey || 'Tracker item';
    navigateToTrackerReference({
      id: related.id,
      issueKey: related.issueKey,
      title,
      type: related.primaryType,
    });
  }, [trackerItems]);

  const trackerItemLink = useMemo(() => {
    if (!associatedItem) return undefined;
    const title = getRecordTitle(associatedItem) || associatedItem.issueKey || 'Tracker item';
    return {
      label: associatedItem.issueKey ?? 'Tracker item',
      title,
      onOpen: () => navigateToTrackerReference({
        id: associatedItem.id,
        issueKey: associatedItem.issueKey,
        title,
        type: associatedItem.primaryType,
      }),
    };
  }, [associatedItem]);

  // Don't render if no tracker data or no data model
  if (!trackerData || !dataModel) {
    return null;
  }

  return (
    <div className="document-header-tracker tracker-document-header">
      <TrackerTypeRow
        typeId={dataModel.type}
        values={localData}
        editable={Boolean(onContentChange)}
        onSaveField={handleSaveField}
        fieldSet="all"
        resetKey={filePath}
        teamMembers={teamMembers}
        relationshipCandidates={relationshipCandidates}
        onOpenItem={handleOpenItem}
        onCreateCollection={trackerFieldCapabilities?.onCreateCollection}
        testIdBase="tracker-document"
        className="border-b border-[var(--nim-border)] pb-3"
        end={trackerItemLink && (
          <button
            type="button"
            className="tracker-document-header-item-link ml-auto inline-flex shrink-0 items-center gap-1 rounded border-none bg-transparent px-1 text-xs text-[var(--nim-text-muted)] cursor-pointer hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            title={`Open tracker item: ${trackerItemLink.title}`}
            aria-label={`Open tracker item ${trackerItemLink.label}`}
            onClick={trackerItemLink.onOpen}
          >
            <MaterialSymbol icon="tag" size={13} />
            {trackerItemLink.label}
          </button>
        )}
      />
      {writeError && (
        <div
          className="tracker-document-header-write-error px-3 py-1.5 text-xs select-text"
          style={{ color: 'var(--nim-error)' }}
          role="alert"
        >
          {`Could not update this file's frontmatter: ${writeError}`}
        </div>
      )}
    </div>
  );
};

/**
 * Helper function to check if content should render tracker header
 */
export function shouldRenderTrackerHeader(content: string, filePath: string): boolean {
  // Only render for markdown files - tracker frontmatter is a markdown convention
  const lowerPath = filePath.toLowerCase();
  if (lowerPath && !lowerPath.endsWith('.md') && !lowerPath.endsWith('.mdx')) {
    return false;
  }
  return detectTrackerFromFrontmatter(content) !== null || detectFlatTypedPage(content, filePath) !== null;
}
