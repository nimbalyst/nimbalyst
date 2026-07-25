import { act, render } from "@testing-library/react";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import {
  $createTableNodeWithDimensions,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import { $getRoot, defineExtension, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";

const tableObserverTeardownExtension = defineExtension({
  name: "@nimbalyst/test/table-observer-teardown",
  namespace: "NimbalystTableObserverTeardownTest",
  nodes: [TableNode, TableRowNode, TableCellNode],
  onError: (error: Error) => {
    throw error;
  },
  $initialEditorState: () => {
    const root = $getRoot();
    for (let index = 0; index < 5; index += 1) {
      root.append($createTableNodeWithDimensions(2, 2, false));
    }
  },
});

function CaptureEditor({
  onReady,
}: {
  onReady: (editor: LexicalEditor) => void;
}): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

function TableEditor({
  onReady,
}: {
  onReady: (editor: LexicalEditor) => void;
}) {
  return (
    <LexicalExtensionComposer
      extension={tableObserverTeardownExtension}
      contentEditable={null}
    >
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <TablePlugin
        hasCellBackgroundColor={false}
        hasCellMerge={false}
        hasHorizontalScroll={false}
      />
      <CaptureEditor onReady={onReady} />
    </LexicalExtensionComposer>
  );
}

describe("TableObserver teardown", () => {
  it("disconnects pending DOM observers before table nodes and the editor are removed", async () => {
    let editor: LexicalEditor | undefined;
    const uncaughtErrors: Error[] = [];
    const handleWindowError = (event: ErrorEvent) => {
      uncaughtErrors.push(
        event.error instanceof Error ? event.error : new Error(event.message)
      );
      event.preventDefault();
    };
    window.addEventListener("error", handleWindowError);

    const view = render(
      <TableEditor
        onReady={(value) => {
          editor = value;
        }}
      />
    );

    try {
      if (!editor) {
        throw new Error("editor not initialized");
      }
      const mountedEditor = editor;
      const tables = Array.from(view.container.querySelectorAll("table"));
      expect(tables).toHaveLength(5);

      await act(async () => {
        for (const table of tables) {
          table.setAttribute("data-nim-1990-pending-mutation", "true");
        }
        mountedEditor.update(
          () => {
            $getRoot().clear();
          },
          { discrete: true }
        );
        view.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(uncaughtErrors).toEqual([]);
    } finally {
      window.removeEventListener("error", handleWindowError);
      view.unmount();
    }
  });
});
