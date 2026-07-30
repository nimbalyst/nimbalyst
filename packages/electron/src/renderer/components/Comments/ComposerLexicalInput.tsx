import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type TriggerFn,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { BOLD_STAR, INLINE_CODE, ITALIC_STAR } from '@lexical/markdown';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import { MentionPicker } from './MentionPicker';
import { EmojiAutocomplete } from './EmojiPicker';
import {
  $createComposerPillNode,
  $isComposerPillNode,
  ComposerPillNode,
  type ComposerPillPayload,
} from './ComposerPillNode';
import { $seedComposer, $serializeComposer } from './composerRichText';
import { EMPTY_POOL, detectTrigger, type DraftPool } from './composerDraft';
import type { MentionCandidate } from './commentViewModel';
import type { EmojiEntry } from './emojiCatalog';

/** Imperative operations the surrounding toolbar needs. */
export interface ComposerInputHandle {
  focus(): void;
  /** Insert a mention or reference pill at the caret, followed by a space. */
  insertPill(payload: ComposerPillPayload): void;
  /** Drop every pill carrying this URN. */
  removePill(urn: string): void;
  insertText(text: string): void;
  clear(): void;
}

/**
 * Only the inline marks the reader understands. No heading, list, quote or
 * fenced-code shortcut is registered, so `# ` stays "# " -- which is exactly
 * what the posted message would show.
 */
const COMPOSER_TRANSFORMERS = [BOLD_STAR, ITALIC_STAR, INLINE_CODE];

const COMPOSER_THEME = {
  paragraph: 'composer-lexical-paragraph',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'rounded bg-[var(--nim-code-bg)] px-1 py-px font-[var(--nim-font-mono)] text-[12px] text-[var(--nim-code-text)]',
  },
};

export interface ComposerLexicalInputProps {
  initialText: string;
  initialPool: DraftPool;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** The message text, re-derived on every edit. */
  onChange: (text: string) => void;
  onSubmit: () => void;
  mentionCandidatesFor: (query: string) => MentionCandidate[];
  /** Records the mention in the pool and returns the pill to insert. */
  onMentionSelected: (candidate: MentionCandidate) => ComposerPillPayload;
  emojiSuggestionsFor: (query: string) => EmojiEntry[];
  /**
   * Files pasted or dropped onto the input. Absent on surfaces that cannot
   * take attachments, where the editor's default handling stays in force.
   */
  onFiles?: (files: File[]) => void;
}

/**
 * The composer input.
 *
 * Rich where the reader is rich and plain everywhere else: bold, italic and
 * code render as you type because the reader renders them, and pills are atomic
 * because a mention is one thing. The text this produces is byte-identical to
 * what the old textarea held, so `deriveDraft` and every validator downstream
 * are untouched.
 */
export const ComposerLexicalInput = forwardRef<ComposerInputHandle, ComposerLexicalInputProps>(
  function ComposerLexicalInput(
    {
      initialText,
      initialPool,
      placeholder,
      ariaLabel,
      autoFocus = false,
      onChange,
      onSubmit,
      mentionCandidatesFor,
      onMentionSelected,
      emojiSuggestionsFor,
      onFiles,
    },
    ref,
  ) {
    const [text, setText] = useState(initialText);
    // Seeding happens once. A parent re-render must never reset what the author
    // has typed since.
    const seed = useRef({ text: initialText, pool: initialPool });
    // Enter belongs to whichever typeahead is open; this is the flag rather
    // than a priority race between two command registrations.
    const typeaheadOpen = useRef(0);

    const initialConfig = useMemo(
      () => ({
        namespace: 'comment-composer',
        theme: COMPOSER_THEME,
        // Block nodes are absent on purpose: the reader has no block forms.
        nodes: [ComposerPillNode],
        onError: (error: Error) => {
          console.error('[CommentComposer] Lexical error:', error);
        },
        editorState: () => {
          $seedComposer(seed.current.text, seed.current.pool);
        },
      }),
      // Captured once; a later prop change must not re-initialize the editor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    const report = useCallback(
      (next: string) => {
        setText(next);
        onChange(next);
      },
      [onChange],
    );

    const handleChange = useCallback(
      (state: EditorState) => {
        state.read(() => report($serializeComposer()));
      },
      [report],
    );

    return (
      <div className="comment-composer-input-shell max-h-[220px] min-h-[52px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] focus-within:border-[var(--nim-border-focus)]">
        <LexicalComposer initialConfig={initialConfig}>
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  data-testid="comment-composer-input"
                  /* Tests and live checks read the derived message text here
                     rather than reaching into the editor state. */
                  data-composer-text={text}
                  aria-label={ariaLabel}
                  aria-placeholder={placeholder}
                  placeholder={
                    <div className="comment-composer-placeholder pointer-events-none absolute left-2.5 top-2 select-none text-[13px] leading-[1.5] text-[var(--nim-text-faint)]">
                      {placeholder}
                    </div>
                  }
                  className="comment-composer-input select-text px-2.5 py-2 text-[13px] leading-[1.5] text-[var(--nim-text)] outline-none"
                />
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
            <SeededTextPlugin report={report} />
            <HistoryPlugin />
            <MarkdownShortcutPlugin transformers={COMPOSER_TRANSFORMERS} />
            {autoFocus && <AutoFocusPlugin />}
            <SubmitOnEnterPlugin onSubmit={onSubmit} typeaheadOpen={typeaheadOpen} />
            {onFiles && <FileDropPlugin onFiles={onFiles} />}
            <ImperativeHandlePlugin forwardedRef={ref} />
            <MentionTypeaheadPlugin
              candidatesFor={mentionCandidatesFor}
              onSelected={onMentionSelected}
              typeaheadOpen={typeaheadOpen}
            />
            <EmojiTypeaheadPlugin suggestionsFor={emojiSuggestionsFor} typeaheadOpen={typeaheadOpen} />
          </div>
        </LexicalComposer>
      </div>
    );
  },
);

/**
 * Report the seeded state once.
 *
 * Seeding runs before any update listener exists, so without this an edit-mode
 * composer would hold whatever text it was handed rather than what its editor
 * actually contains. What the author can see is what gets sent.
 */
function SeededTextPlugin({ report }: { report: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();

  React.useEffect(() => {
    editor.getEditorState().read(() => report($serializeComposer()));
    // Mount only: every later change arrives through OnChangePlugin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return null;
}

/**
 * Enter sends, Shift+Enter breaks the line.
 *
 * Registered above the rich-text default so Enter never inserts a paragraph,
 * and below nothing: while a typeahead is open the counter is non-zero and this
 * declines, leaving Enter to accept the highlighted option.
 */
function SubmitOnEnterPlugin({
  onSubmit,
  typeaheadOpen,
}: {
  onSubmit: () => void;
  typeaheadOpen: React.MutableRefObject<number>;
}) {
  const [editor] = useLexicalComposerContext();

  React.useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (typeaheadOpen.current > 0) return false;
          if (event === null || event.isComposing) return false;
          event.preventDefault();
          if (event.shiftKey) {
            // Owned here rather than left to the rich-text default so the one
            // key that does not send behaves identically wherever the composer
            // is mounted.
            editor.update(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection)) selection.insertLineBreak(false);
            });
            return true;
          }
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, onSubmit, typeaheadOpen],
  );

  return null;
}

/**
 * Pasted and dropped files.
 *
 * `RichTextPlugin` already turns both gestures into one `DRAG_DROP_PASTE`
 * command carrying the files; until now nothing listened and they were
 * discarded. Handled above the default priority and returning true, so a
 * pasted screenshot never also lands as its file name in the text.
 *
 * The files leave the editor entirely -- the composer holds them. This input
 * stays text-only, which is what keeps its serialized text identical to what
 * the validators and the wire format expect.
 */
function FileDropPlugin({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [editor] = useLexicalComposerContext();

  React.useEffect(
    () =>
      editor.registerCommand(
        DRAG_DROP_PASTE,
        (files) => {
          if (!files || files.length === 0) return false;
          onFiles([...files]);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, onFiles],
  );

  return null;
}

function ImperativeHandlePlugin({
  forwardedRef,
}: {
  forwardedRef: React.ForwardedRef<ComposerInputHandle>;
}) {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editor.focus(),
      insertPill: (payload: ComposerPillPayload) => {
        editor.update(() => {
          const pill = $createComposerPillNode(payload);
          const space = $createTextNode(' ');
          $insertAtCaret([pill, space]);
          space.selectEnd();
        });
        editor.focus();
      },
      removePill: (urn: string) => {
        editor.update(() => {
          for (const node of $collectPills()) {
            if (node.getUrn() === urn) node.remove();
          }
        });
      },
      insertText: (value: string) => {
        editor.update(() => {
          $insertAtCaret([$createTextNode(value)]);
        });
        editor.focus();
      },
      clear: () => {
        editor.update(() => {
          $seedComposer('', EMPTY_POOL);
        });
      },
    }),
    [editor],
  );

  return null;
}

function $insertAtCaret(nodes: LexicalNode[]): void {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertNodes(nodes);
    return;
  }
  // No caret yet (the author has not focused the input): append to the end.
  const last = $getRoot().getLastChild();
  if ($isElementNode(last)) last.append(...nodes);
  else $getRoot().append(...nodes);
}

function $collectPills(): ComposerPillNode[] {
  const found: ComposerPillNode[] = [];
  const walk = (node: ElementNode) => {
    for (const child of node.getChildren()) {
      if ($isComposerPillNode(child)) found.push(child);
      else if ($isElementNode(child)) walk(child);
    }
  };
  walk($getRoot());
  return found;
}

class MentionOption extends MenuOption {
  constructor(public candidate: MentionCandidate) {
    super(
      candidate.kind === 'person'
        ? `person:${candidate.person.userId}`
        : `agent:${candidate.agent.sessionId}`,
    );
  }
}

class EmojiOption extends MenuOption {
  constructor(public entry: EmojiEntry) {
    super(`emoji:${entry.shortcode}`);
  }
}

/**
 * The `@` list. `detectTrigger` still decides what counts as a trigger, so the
 * word-boundary rules (and their tests) are shared with the old textarea.
 */
function MentionTypeaheadPlugin({
  candidatesFor,
  onSelected,
  typeaheadOpen,
}: {
  candidatesFor: (query: string) => MentionCandidate[];
  onSelected: (candidate: MentionCandidate) => ComposerPillPayload;
  typeaheadOpen: React.MutableRefObject<number>;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const candidates = useMemo(
    () => (query === null ? [] : candidatesFor(query)),
    [candidatesFor, query],
  );
  const options = useMemo(() => candidates.map((candidate) => new MentionOption(candidate)), [candidates]);

  const triggerFn = useCallback<TriggerFn>((text) => {
    const detected = detectTrigger(text, text.length);
    if (detected?.kind !== 'mention') return null;
    return {
      leadOffset: detected.start,
      matchingString: detected.query,
      replaceableString: text.slice(detected.start),
    };
  }, []);

  const onSelectOption = useCallback(
    (option: MentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      const pill = $createComposerPillNode(onSelected(option.candidate));
      const space = $createTextNode(' ');
      if (nodeToReplace) {
        nodeToReplace.replace(pill);
        pill.insertAfter(space);
      } else {
        $insertAtCaret([pill, space]);
      }
      space.selectEnd();
      closeMenu();
    },
    [onSelected],
  );

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={() => {
        typeaheadOpen.current += 1;
      }}
      onClose={() => {
        typeaheadOpen.current = Math.max(0, typeaheadOpen.current - 1);
      }}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => (
        <MentionPicker
          anchorRect={anchorElementRef.current?.getBoundingClientRect() ?? null}
          candidates={candidates}
          activeIndex={selectedIndex ?? 0}
          onSelect={(candidate) => {
            const index = candidates.indexOf(candidate);
            const option = options[index];
            if (option) selectOptionAndCleanUp(option);
          }}
          onActiveIndexChange={setHighlightedIndex}
        />
      )}
    />
  );
}

/** The `:shortcode` list. Selection inserts the glyph, as the toolbar does. */
function EmojiTypeaheadPlugin({
  suggestionsFor,
  typeaheadOpen,
}: {
  suggestionsFor: (query: string) => EmojiEntry[];
  typeaheadOpen: React.MutableRefObject<number>;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const entries = useMemo(
    () => (query === null ? [] : suggestionsFor(query)),
    [query, suggestionsFor],
  );
  const options = useMemo(() => entries.map((entry) => new EmojiOption(entry)), [entries]);

  const triggerFn = useCallback<TriggerFn>((text) => {
    const detected = detectTrigger(text, text.length);
    if (detected?.kind !== 'emoji') return null;
    return {
      leadOffset: detected.start,
      matchingString: detected.query,
      replaceableString: text.slice(detected.start),
    };
  }, []);

  const onSelectOption = useCallback(
    (option: EmojiOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      const glyph = $createTextNode(`${option.entry.glyph} `);
      if (nodeToReplace) nodeToReplace.replace(glyph);
      else $insertAtCaret([glyph]);
      glyph.selectEnd();
      closeMenu();
    },
    [],
  );

  return (
    <LexicalTypeaheadMenuPlugin<EmojiOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={() => {
        typeaheadOpen.current += 1;
      }}
      onClose={() => {
        typeaheadOpen.current = Math.max(0, typeaheadOpen.current - 1);
      }}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => (
        <EmojiAutocomplete
          anchorRect={anchorElementRef.current?.getBoundingClientRect() ?? null}
          entries={entries}
          activeIndex={selectedIndex ?? 0}
          onSelect={(entry) => {
            const option = options[entries.indexOf(entry)];
            if (option) selectOptionAndCleanUp(option);
          }}
          onActiveIndexChange={setHighlightedIndex}
        />
      )}
    />
  );
}
