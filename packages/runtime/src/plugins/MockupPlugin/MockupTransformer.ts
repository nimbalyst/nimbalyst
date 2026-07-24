/**
 * MockupTransformer - Markdown transformer for mockup nodes.
 *
 * Uses standard markdown linked image syntax for compatibility with other editors.
 * Format: [![alt](screenshot.png)](feature.mockup.html){width}x{height}
 *
 * This renders as a clickable image in standard markdown viewers, with the
 * screenshot displayed and linking to the mockup source file.
 */

import { TextMatchTransformer } from '@lexical/markdown';

import { $createMockupNode, $isMockupNode, MockupNode } from './MockupNode';

/**
 * Regex for importing mockup from markdown.
 * Matches: [![alt](screenshot.png)](feature.mockup.html){widthxheight}
 *
 * Groups:
 * 1. alt text
 * 2. screenshot path (can be empty)
 * 3. mockup path (must end in .mockup.html)
 * 4. width (optional)
 * 5. height (optional)
 *
 * Note: screenshot path can be empty (e.g., `()`) for mockups still generating.
 * Size syntax is `{widthxheight}` matching the image format.
 */
const MOCKUP_IMPORT_REGEX =
  /\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*\.mockup\.html)\)(?:\{(\d+)x(\d+)\})?/;

/**
 * Regex for detecting mockup while typing (triggers on closing paren or brace).
 */
const MOCKUP_TYPING_REGEX =
  /\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*\.mockup\.html)\)(?:\{(\d+)x(\d+)\})?$/;

export const MOCKUP_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MockupNode],

  export: (node) => {
    if (!$isMockupNode(node)) {
      return null;
    }

    const altText = node.getAltText();
    const screenshotPath = node.getScreenshotPath();
    const mockupPath = node.getMockupPath();
    const width = node.__width;
    const height = node.__height;

    // Build the linked image markdown: [![alt](screenshot)](mockup.html)
    let markdown = `[![${altText}](${screenshotPath})](${mockupPath})`;

    // Add size if both width and height are set (format: {widthxheight})
    if (width !== 'inherit' && height !== 'inherit') {
      markdown += `{${Math.round(width)}x${Math.round(height)}}`;
    }

    return markdown;
  },

  importRegExp: MOCKUP_IMPORT_REGEX,
  regExp: MOCKUP_TYPING_REGEX,

  replace: (textNode, match) => {
    const [, altText, screenshotPath, mockupPath, width, height] = match;

    const mockupNode = $createMockupNode({
      mockupPath,
      screenshotPath,
      altText: altText || 'Mockup',
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
    });

    textNode.replace(mockupNode);
  },

  trigger: ')',
  type: 'text-match',
};
