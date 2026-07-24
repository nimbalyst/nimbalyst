/**
 * Transformer for TrackerItem nodes
 * Exports/imports tracker items in markdown format with metadata
 * Format: #bug[id:bug_123 status:to-do]
 */

import { ElementTransformer, TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode, ElementNode, LexicalNode, TextNode } from 'lexical';
import {
  $createTrackerItemNode,
  $isTrackerItemNode,
  TrackerItemData,
  TrackerItemNode,
} from './TrackerItemNode';

// Helper function to generate a ULID-style ID
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

// ElementTransformer for EXPORT (handles ElementNode serialization)
export const TRACKER_ITEM_ELEMENT_TRANSFORMER: ElementTransformer = {
  dependencies: [TrackerItemNode],
  export: (node: LexicalNode, exportChildren: (elementNode: ElementNode) => string) => {
    if (!$isTrackerItemNode(node)) {
      return null;
    }

    const data = node.getData();

    // Get text content from children
    const textContent = exportChildren(node);

    // Create the metadata object (omit undefined fields and title since it's in text)
    const metadata: Partial<TrackerItemData> = {
      id: data.id,
      type: data.type,
      status: data.status,
    };

    if (data.priority) metadata.priority = data.priority;
    if (data.owner) metadata.owner = data.owner;
    if (data.tags && data.tags.length > 0) metadata.tags = data.tags;
    if (data.created) metadata.created = data.created;
    if (data.updated) metadata.updated = data.updated;

    // Export as: text content @type[metadata...]
    const parts: string[] = [];
    parts.push(`id:${metadata.id}`);
    parts.push(`status:${metadata.status}`);
    if (metadata.priority) parts.push(`priority:${metadata.priority}`);
    if (metadata.owner) parts.push(`owner:${metadata.owner}`);
    if (metadata.created) parts.push(`created:${metadata.created}`);
    if (metadata.updated) parts.push(`updated:${metadata.updated}`);
    if (metadata.tags && metadata.tags.length > 0) parts.push(`tags:${metadata.tags.join(',')}`);

    let result = `${textContent} #${data.type}[${parts.join(' ')}]`;

    // Add description as indented lines if present
    if (data.description) {
      const descriptionLines = data.description.split('\n');
      const indentedDescription = descriptionLines.map(line => `  ${line}`).join('\n');
      result += '\n' + indentedDescription;
    }

    return result;
  },
  regExp: /(?!)/,  // Never match - negative lookahead that always fails
  replace: () => {},
  type: 'element',
};

// TextMatchTransformer for IMPORT (handles markdown with #bug[...] metadata)
export const TRACKER_ITEM_TEXT_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TrackerItemNode],
  export: () => null,  // Export handled by ElementTransformer
  importRegExp: /^(.+?)\s+#([a-z][\w-]*)\[.+?\]$/,
  regExp: /^(.+?)\s+#([a-z][\w-]*)\[.+?\]$/,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    // console.log('TrackerItem transformer matched:', match[0]);
    const fullMatch = match[0];

    // Extract text content and metadata
    const contentMatch = fullMatch.match(/^(.+?)\s+#([a-z][\w-]*)\[(.+?)\]$/);
    if (!contentMatch) {
      console.log('No content match found');
      return;
    }

    const [, textContent, type, propsStr] = contentMatch;
    // console.log('Text:', textContent, 'Type:', type, 'Props:', propsStr);

    try {
      // Parse key:value pairs
      const metadata: Partial<TrackerItemData> = { type: type as TrackerItemData['type'] };

      // Match key:value or key:"value with spaces"
      const propRegex = /(\w+):((?:"[^"]*")|(?:[^\s]+))/g;
      let propMatch;
      while ((propMatch = propRegex.exec(propsStr)) !== null) {
        const [, key, value] = propMatch;
        const cleanValue = value.startsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;

        switch (key) {
          case 'id': metadata.id = cleanValue; break;
          case 'status': metadata.status = cleanValue as TrackerItemData['status']; break;
          case 'priority': metadata.priority = cleanValue as TrackerItemData['priority']; break;
          case 'owner': metadata.owner = cleanValue; break;
          case 'created': metadata.created = cleanValue; break;
          case 'updated': metadata.updated = cleanValue; break;
          case 'tags': metadata.tags = cleanValue.split(','); break;
        }
      }

      // Generate ID if not present
      const id = metadata.id || generateId(type || 'tsk');

      // Note: Description will be handled by the parser in ElectronDocumentService
      // since it requires looking at following lines. The transformer only handles
      // the inline portion.
      const data: TrackerItemData = {
        id,
        type: (type || metadata.type || 'task') as TrackerItemData['type'],
        title: textContent.trim(),
        status: metadata.status || 'to-do',
        priority: metadata.priority,
        owner: metadata.owner,
        tags: metadata.tags,
        created: metadata.created || new Date().toISOString().split('T')[0],
        updated: metadata.updated,
      };

      // console.log('Creating TrackerItemNode with data:', data);
      const node = $createTrackerItemNode(data);

      // Add text content as children
      const childTextNode = $createTextNode(textContent.trim());
      node.append(childTextNode);

      // console.log('Created node:', node);
      textNode.replace(node);
    } catch (e) {
      // If parsing fails, leave as text
      console.error('Failed to parse tracker item metadata:', e);
    }
  },
  trigger: '#',
  type: 'text-match',
};

// Export both transformers as an array for convenience
export const TRACKER_ITEM_TRANSFORMERS = [
  TRACKER_ITEM_ELEMENT_TRANSFORMER,
  TRACKER_ITEM_TEXT_TRANSFORMER,
];
