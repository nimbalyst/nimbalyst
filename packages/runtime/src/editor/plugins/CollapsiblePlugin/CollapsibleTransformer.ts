/**
 * Transformer for collapsible nodes using HTML details/summary syntax
 * Supports standard markdown-compatible collapsible sections
 */

import {$createTextNode, $isElementNode, $isTextNode, LexicalNode} from 'lexical';
import {MultilineElementTransformer} from '@lexical/markdown';
import {$convertFromEnhancedMarkdownString, $convertNodeToEnhancedMarkdownString} from '../../markdown';
import {
    $createStyledCollapsible,
} from './index';
import { $isCollapsibleContainerNode } from "./CollapsibleContainerNode";
import { $isCollapsibleTitleNode } from "./CollapsibleTitleNode";
import { $isCollapsibleContentNode } from "./CollapsibleContentNode";

// Import core transformers directly to avoid circular dependency
// Plugin transformers shouldn't be needed inside collapsible content
import { CORE_TRANSFORMERS } from '../../markdown/core-transformers';

// Extract text content from a node tree (for title only)
function extractTextContent(node: LexicalNode): string {
    if ($isTextNode(node)) {
        return node.getTextContent();
    }

    if ($isElementNode(node)) {
        const children = node.getChildren();
        return children.map(child => extractTextContent(child)).join('');
    }

    return '';
}

// Parse HTML attributes from the details tag
function parseDetailsAttributes(detailsTag: string): { open?: boolean; className?: string } {
    const attributes: { open?: boolean; className?: string } = {};

    // Check for open attribute
    if (/\sopen(?:\s|>|$)/.test(detailsTag)) {
        attributes.open = true;
    }

    // Extract class attribute if present
    const classMatch = detailsTag.match(/class=["']([^"']+)["']/);
    if (classMatch) {
        attributes.className = classMatch[1];
    }

    return attributes;
}

export const COLLAPSIBLE_TRANSFORMER: MultilineElementTransformer = {
    dependencies: [],
    export: (node: LexicalNode) => {
        if (!$isCollapsibleContainerNode(node)) {
            return null;
        }

        const children = node.getChildren();
        const titleNode = children.find($isCollapsibleTitleNode);
        const contentNode = children.find($isCollapsibleContentNode);

        if (!titleNode || !contentNode) {
            return null;
        }

        // Extract title as plain text
        const title = extractTextContent(titleNode);

        // Convert content to markdown
        let bodyMarkdown = '';

        try {
            // Convert each child to markdown
            bodyMarkdown =  $convertNodeToEnhancedMarkdownString(CORE_TRANSFORMERS, contentNode, true)
        } catch (error) {
            console.warn('Failed to process content children:', error);
            return null;
        }

        // Build the HTML details/summary structure
        const openAttr = node.getOpen() ? ' open' : '';
        const classAttr = node.getClassification() ? ` class="${node.getClassification()}"` : '';

        let output = `<details${openAttr}${classAttr}>\n`;
        output += `<summary>${title}</summary>\n`;

        if (bodyMarkdown) {
            output += '\n' + bodyMarkdown + '\n';
        }

        output += '</details>';

        return output;
    },
    // Match opening <details> tag with optional attributes
    regExpStart: /^<details(?:\s+[^>]*)?>$/,
    // Match closing </details> tag
    regExpEnd: /^<\/details>$/,
    replace: (rootNode, children, startMatch, endMatch, linesInBetween) => {
        // Parse attributes from the opening tag
        const detailsTag = startMatch[0];
        const attributes = parseDetailsAttributes(detailsTag);

        // Find the summary line
        const lines = linesInBetween || [];
        let summaryText = 'Collapsible Section';
        let contentStartIndex = 0;

        // Look for <summary> tags
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Check for single-line summary
            const singleLineMatch = line.match(/^<summary>(.+?)<\/summary>$/);
            if (singleLineMatch) {
                summaryText = singleLineMatch[1].trim();
                contentStartIndex = i + 1;
                break;
            }

            // Check for multi-line summary start
            if (line.startsWith('<summary>')) {
                let summaryContent = line.substring(9); // Remove <summary>
                let j = i + 1;

                // Look for closing tag
                while (j < lines.length) {
                    const nextLine = lines[j];
                    const closeIndex = nextLine.indexOf('</summary>');

                    if (closeIndex !== -1) {
                        summaryContent += ' ' + nextLine.substring(0, closeIndex);
                        summaryText = summaryContent.trim();
                        contentStartIndex = j + 1;
                        break;
                    } else {
                        summaryContent += ' ' + nextLine;
                    }
                    j++;
                }
                break;
            }
        }

        // Extract content after summary
        const contentLines = lines.slice(contentStartIndex);
        const content = contentLines.join('\n').trim();

        // Map class attribute to classification
        let classification = attributes.className;
        // Handle special class mappings if needed
        if (classification === 'thinking' || classification === 'note' || classification === 'warning') {
            // These are valid classifications
        } else if (classification) {
            // Default to undefined if not a recognized classification
            classification = undefined;
        }

        // Create the collapsible
        const { container, titleParagraph, content: contentNode } = $createStyledCollapsible({
            classification: classification as any,
            isOpen: attributes.open !== undefined ? attributes.open : false,
            readOnly: false,
        });

        // Set the title
        titleParagraph.append($createTextNode(summaryText));

        // Parse the body content as markdown
        if (content) {
            try {
                $convertFromEnhancedMarkdownString(content, CORE_TRANSFORMERS, contentNode, true, false);
            } catch (error) {
                console.warn('Failed to convert markdown to nodes:', error);
                // Fallback: add as plain text
                contentNode.append($createTextNode(content));
            }
        }

        // Replace the root node with our container
        rootNode.append(container);

        // Set safe selection after transformation
        try {
            container.selectEnd();
        } catch (error) {
            console.warn('Failed to set selection after collapsible creation:', error);
        }
    },
    type: 'multiline-element',
};
