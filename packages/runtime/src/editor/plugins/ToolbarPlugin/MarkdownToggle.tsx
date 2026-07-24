import { useCallback } from 'react';
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot } from 'lexical';
import { $isCodeNode, CodeNode } from '@lexical/code';
import { $convertFromEnhancedMarkdownString, $convertToEnhancedMarkdownString, getEditorTransformers } from '../../markdown';

const MarkdownToggle = () => {
    const [editor] = useLexicalComposerContext();
    const shouldPreserveNewLinesInMarkdown = true;

    const handleMarkdownToggle = useCallback(() => {
        editor.update(() => {
            const transformers = getEditorTransformers();
            const root = $getRoot();
            const firstChild = root.getFirstChild();
            if ($isCodeNode(firstChild) && firstChild.getLanguage() === 'markdown') {
                $convertFromEnhancedMarkdownString(
                    firstChild.getTextContent(),
                    transformers
                );
            } else {
                const markdown = $convertToEnhancedMarkdownString(transformers);
                // GH: Had to not use $create because the $applyNodeReplacement fails on duplicate key
                // not sure what changed
                const codeNode = new CodeNode('markdown');
                codeNode.append($createTextNode(markdown));
                root.clear().append(codeNode);
                if (markdown.length === 0) {
                    codeNode.select();
                }
            }
        });
    }, [editor, shouldPreserveNewLinesInMarkdown]);

    return (
        <button
            onClick={handleMarkdownToggle}
            className="toolbar-item spaced"
            title="Convert From/To Markdown"
            aria-label="Convert from/to markdown">
            <i className="format bug" />
        </button>
    );
};

export default MarkdownToggle;
