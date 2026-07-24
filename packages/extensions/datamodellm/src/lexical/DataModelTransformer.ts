/**
 * DataModelTransformer - Markdown transformer for data model nodes.
 *
 * Uses standard markdown linked image syntax for compatibility with other editors.
 * Format: [![alt](screenshot.png)](model.prisma){width}x{height}
 *
 * This renders as a clickable image in standard markdown viewers, with the
 * screenshot displayed and linking to the data model source file.
 */

import { TextMatchTransformer } from '@lexical/markdown';

import { $createDataModelNode, $isDataModelNode, DataModelNode } from './DataModelNode';

/**
 * Regex for importing data model from markdown.
 * Matches: [![alt](screenshot.png)](model.prisma){widthxheight}
 *
 * Groups:
 * 1. alt text
 * 2. screenshot path (can be empty)
 * 3. data model path (must end in .prisma)
 * 4. width (optional)
 * 5. height (optional)
 *
 * Note: screenshot path can be empty (e.g., `()`) for data models still generating.
 * Size syntax is `{widthxheight}` matching the image format.
 */
const DATAMODEL_IMPORT_REGEX =
  /\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*\.prisma)\)(?:\{(\d+)x(\d+)\})?/;

/**
 * Regex for detecting data model while typing (triggers on closing paren or brace).
 */
const DATAMODEL_TYPING_REGEX =
  /\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*\.prisma)\)(?:\{(\d+)x(\d+)\})?$/;

export const DATAMODEL_TRANSFORMER: TextMatchTransformer = {
  dependencies: [DataModelNode],

  export: (node) => {
    if (!$isDataModelNode(node)) {
      return null;
    }

    const altText = node.getAltText();
    const screenshotPath = node.getScreenshotPath();
    const dataModelPath = node.getDataModelPath();
    const width = node.__width;
    const height = node.__height;

    // Build the linked image markdown: [![alt](screenshot)](model.prisma)
    let markdown = `[![${altText}](${screenshotPath})](${dataModelPath})`;

    // Add size if both width and height are set (format: {widthxheight})
    if (width !== 'inherit' && height !== 'inherit') {
      markdown += `{${Math.round(width)}x${Math.round(height)}}`;
    }

    return markdown;
  },

  importRegExp: DATAMODEL_IMPORT_REGEX,
  regExp: DATAMODEL_TYPING_REGEX,

  replace: (textNode, match) => {
    const [, altText, screenshotPath, dataModelPath, width, height] = match;

    const dataModelNode = $createDataModelNode({
      dataModelPath,
      screenshotPath,
      altText: altText || 'Data Model',
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
    });

    textNode.replace(dataModelNode);
  },

  trigger: ')',
  type: 'text-match',
};
