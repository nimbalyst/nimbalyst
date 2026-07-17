/**
 * TrackerDocumentHeader - Renders tracker status bar for full-document tracking
 *
 * This component:
 * - Detects tracker frontmatter in document content
 * - Loads the appropriate tracker data model
 * - Renders the StatusBar component with tracker data
 * - Updates frontmatter when fields change
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { StatusBar } from '../components/StatusBar';
import { ModelLoader } from '../models/ModelLoader';
import type { TrackerDataModel } from '../models/TrackerDataModel';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsMapAtom } from '../trackerDataAtoms';
import { getRecordTitle } from '../trackerRecordAccessors';
import { navigateToTrackerReference } from '../../TrackerLinkPlugin/trackerReferenceData';
import { detectTrackerFromFrontmatter, updateTrackerInFrontmatter } from './frontmatterUtils';
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
}) => {
  const [dataModel, setDataModel] = useState<TrackerDataModel | null>(null);
  const [trackerType, setTrackerType] = useState<string | null>(null);
  const trackerItems = useAtomValue(trackerItemsMapAtom);

  // Get fresh tracker data when contentVersion changes
  const trackerData = useMemo(() => {
    const content = getContent();
    return detectTrackerFromFrontmatter(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getContent, contentVersion]);

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

  // Handle field changes - get fresh content at the moment of change
  const handleChange = useCallback((updates: Record<string, any>) => {
    if (!trackerData || !onContentChange) return;

    // Get fresh content and update with new frontmatter
    const currentContent = getContent();
    const updatedContent = updateTrackerInFrontmatter(currentContent, trackerData.type, updates);
    onContentChange(updatedContent);
  }, [getContent, trackerData, onContentChange]);

  const associatedItem = useMemo(() => {
    if (!trackerData) return null;
    return findAssociatedTrackerItem(trackerItems.values(), filePath, trackerData.type);
  }, [filePath, trackerData, trackerItems]);

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
    <div className="document-header-tracker">
      <StatusBar
        model={dataModel}
        data={trackerData.data}
        onChange={handleChange}
        trackerItemLink={trackerItemLink}
      />
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
  const detected = detectTrackerFromFrontmatter(content);
  return detected !== null;
}
