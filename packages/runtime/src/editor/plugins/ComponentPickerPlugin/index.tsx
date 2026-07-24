/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';
import {useEffect, useMemo, useState, useCallback} from 'react';

import {$createCodeNode} from '@lexical/code';
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {INSERT_HORIZONTAL_RULE_COMMAND} from '@lexical/extension';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  LexicalEditor,
  TextNode,
} from 'lexical';

import useModal from '../../hooks/useModal';
import {INSERT_COLLAPSIBLE_COMMAND} from '../CollapsiblePlugin';
import InsertLayoutDialog from '../LayoutPlugin/InsertLayoutDialog';
import {INSERT_PAGE_BREAK} from '../PageBreakPlugin';
import {InsertTableDialog} from '../TablePlugin/TablePlugin';
import {
  getAllExtensionDynamicOptions,
  getAllExtensionUserCommands,
  subscribeToExtensionContributions,
} from '../../extensions/extensionContributionsStore';
// Kanban board insert item is commented out (feature unfinished); import unused.
// import {INSERT_BOARD_COMMAND} from '../KanbanBoardPlugin/BoardCommands';
import {
  TypeaheadMenuPlugin,
  TypeaheadMenuOption,
} from '../TypeaheadPlugin/TypeaheadMenuPlugin';
import {
  createBasicTriggerFunction,
} from '../TypeaheadPlugin/TypeaheadMenu';

// ============================================================================
// MATERIAL SYMBOLS ICON SUPPORT
// ============================================================================

/**
 * Material Symbols icon component that loads icons by name
 * Uses Google's Material Symbols font (Outlined variant)
 */
export const MaterialIcon: React.FC<{name: string; className?: string; style?: React.CSSProperties}> = ({
  name,
  className = '',
  style = {},
}) => {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{
        fontSize: '18px',
        width: '18px',
        height: '18px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      {name}
    </span>
  );
};

/**
 * Load Material Symbols font if not already loaded
 * Call this once at app initialization
 */
export function ensureMaterialSymbolsLoaded() {
  // Check if already loaded
  if (document.getElementById('material-symbols-font')) {
    return;
  }

  // Add the font link
  const link = document.createElement('link');
  link.id = 'material-symbols-font';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200';
  document.head.appendChild(link);
}

// ============================================================================
// COMPONENT PICKER OPTIONS
// ============================================================================

type ShowModal = ReturnType<typeof useModal>[1];

function getDynamicOptions(editor: LexicalEditor, queryString: string): TypeaheadMenuOption[] {
  const options: TypeaheadMenuOption[] = [];

  if (queryString == null) {
    return options;
  }

  const tableMatch = queryString.match(/^([1-9]\d?)(?:x([1-9]\d?)?)?$/);

  if (tableMatch !== null) {
    const rows = tableMatch[1];
    const colOptions = tableMatch[2]
      ? [tableMatch[2]]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(String);

    options.push(
      ...colOptions.map(
        (columns) => ({
          id: `table-${rows}x${columns}`,
          label: `${rows}x${columns} Table`,
          icon: <MaterialIcon name="table" />,
          keywords: ['table'],
          section: 'Tables',
          onSelect: () =>
            editor.dispatchCommand(INSERT_TABLE_COMMAND, {columns, rows}),
        }),
      ),
    );
  }

  return options;
}

function getBaseOptions(editor: LexicalEditor, showModal: ShowModal): TypeaheadMenuOption[] {
  return [
    // {
    //   id: 'paragraph',
    //   label: 'Paragraph',
    //   icon: <MaterialIcon name="notes" />,
    //   keywords: ['normal', 'paragraph', 'p', 'text'],
    //   section: 'Basic blocks',
    //   onSelect: () =>
    //     editor.update(() => {
    //       const selection = $getSelection();
    //       if ($isRangeSelection(selection)) {
    //         $setBlocksType(selection, () => $createParagraphNode());
    //       }
    //     }),
    // },
    {
      id: 'heading-1',
      label: 'Heading 1',
      icon: <MaterialIcon name="title" />,
      keywords: ['heading', 'header', 'h1'],
      section: 'Basic blocks',
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createHeadingNode('h1'));
          }
        }),
    },
    {
      id: 'heading-2',
      label: 'Heading 2',
      icon: <MaterialIcon name="title" />,
      keywords: ['heading', 'header', 'h2'],
      section: 'Basic blocks',
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createHeadingNode('h2'));
          }
        }),
    },
    {
      id: 'heading-3',
      label: 'Heading 3',
      icon: <MaterialIcon name="title" />,
      keywords: ['heading', 'header', 'h3'],
      section: 'Basic blocks',
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createHeadingNode('h3'));
          }
        }),
    },
    {
      id: 'table',
      label: 'Table',
      icon: <MaterialIcon name="table" />,
      keywords: ['table', 'grid', 'spreadsheet', 'rows', 'columns'],
      section: 'Tables',
      onSelect: () =>
        showModal('Insert Table', (onClose) => (
          <InsertTableDialog activeEditor={editor} onClose={onClose} />
        )),
    },
    {
      id: 'numbered-list',
      label: 'Numbered List',
      icon: <MaterialIcon name="format_list_numbered" />,
      keywords: ['numbered list', 'ordered list', 'ol'],
      section: 'Lists',
      onSelect: () =>
        editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
    },
    {
      id: 'bulleted-list',
      label: 'Bulleted List',
      icon: <MaterialIcon name="format_list_bulleted" />,
      keywords: ['bulleted list', 'unordered list', 'ul'],
      section: 'Lists',
      onSelect: () =>
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
    },
    {
      id: 'check-list',
      label: 'Check List',
      icon: <MaterialIcon name="checklist" />,
      keywords: ['check list', 'todo list'],
      section: 'Lists',
      onSelect: () =>
        editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined),
    },
    {
      id: 'quote',
      label: 'Quote',
      icon: <MaterialIcon name="format_quote" />,
      keywords: ['block quote', 'quotation'],
      section: 'Basic blocks',
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createQuoteNode());
          }
        }),
    },
    {
      id: 'code',
      label: 'Code Block',
      icon: <MaterialIcon name="code" />,
      keywords: ['javascript', 'python', 'js', 'codeblock'],
      section: 'Basic blocks',
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();

          if ($isRangeSelection(selection)) {
            if (selection.isCollapsed()) {
              $setBlocksType(selection, () => $createCodeNode());
            } else {
              const textContent = selection.getTextContent();
              const codeNode = $createCodeNode();
              selection.insertNodes([codeNode]);
              selection.insertRawText(textContent);
            }
          }
        }),
    },
    {
      id: 'divider',
      label: 'Divider',
      icon: <MaterialIcon name="horizontal_rule" />,
      keywords: ['horizontal rule', 'divider', 'hr'],
      section: 'Layout',
      onSelect: () =>
        editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined),
    },
    {
      id: 'page-break',
      label: 'Page Break',
      icon: <MaterialIcon name="insert_page_break" />,
      keywords: ['page break', 'divider'],
      section: 'Layout',
      onSelect: () => editor.dispatchCommand(INSERT_PAGE_BREAK, undefined),
    },
    // Disabled until the embed insert handlers are implemented.
    // ...EmbedConfigs.map(
    //   (embedConfig) => ({
    //     id: `embed-${embedConfig.type}`,
    //     label: `Embed ${embedConfig.contentName}`,
    //     icon: embedConfig.icon,
    //     keywords: [...embedConfig.keywords, 'embed'],
    //     section: 'Media',
    //     onSelect: () =>
    //       editor.dispatchCommand(INSERT_EMBED_COMMAND, embedConfig.type),
    //   }),
    // ),
    {
      id: 'collapsible',
      label: 'Collapsible',
      icon: <MaterialIcon name="expand_more" />,
      keywords: ['collapse', 'collapsible', 'toggle'],
      section: 'Layout',
      onSelect: () =>
        editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, undefined),
    },
    {
      id: 'columns-layout',
      label: 'Columns Layout',
      icon: <MaterialIcon name="view_column" />,
      keywords: ['columns', 'layout', 'grid'],
      section: 'Layout',
      onSelect: () =>
        showModal('Insert Columns Layout', (onClose) => (
          <InsertLayoutDialog activeEditor={editor} onClose={onClose} />
        )),
    },
    // The Kanban "Board" insert item is commented out — the Kanban board
    // feature was never finished. Re-enable when the board work resumes.
    // {
    //   id: 'board',
    //   label: 'Board',
    //   icon: <MaterialIcon name="view_kanban" />,
    //   keywords: ['board', 'kanban', 'tasks', 'cards', 'columns'],
    //   section: 'Layout',
    //   onSelect: () =>
    //     editor.dispatchCommand(INSERT_BOARD_COMMAND, undefined),
    // },
    // {
    //   id: 'align-left',
    //   label: 'Align Left',
    //   icon: <MaterialIcon name="format_align_left" />,
    //   keywords: ['align', 'left'],
    //   section: 'Alignment',
    //   onSelect: () =>
    //     editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left'),
    // },
    // {
    //   id: 'align-center',
    //   label: 'Align Center',
    //   icon: <MaterialIcon name="format_align_center" />,
    //   keywords: ['align', 'center'],
    //   section: 'Alignment',
    //   onSelect: () =>
    //     editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'),
    // },
    // {
    //   id: 'align-right',
    //   label: 'Align Right',
    //   icon: <MaterialIcon name="format_align_right" />,
    //   keywords: ['align', 'right'],
    //   section: 'Alignment',
    //   onSelect: () =>
    //     editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'),
    // },
    // {
    //   id: 'align-justify',
    //   label: 'Align Justify',
    //   icon: <MaterialIcon name="format_align_justify" />,
    //   keywords: ['align', 'justify'],
    //   section: 'Alignment',
    //   onSelect: () =>
    //     editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify'),
    // },
    // Add user commands contributed by extensions
    ...getAllExtensionUserCommands().map(
      (userCommand) => ({
        id: `plugin-${userCommand.title.toLowerCase().replace(/\s+/g, '-')}`,
        label: userCommand.title,
        icon: userCommand.icon ? <MaterialIcon name={userCommand.icon} /> : undefined,
        keywords: userCommand.keywords || [],
        section: 'Plugins',
        onSelect: () =>
          editor.dispatchCommand(userCommand.command, userCommand.payload),
      }),
    ),
  ];
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export default function ComponentPickerMenuPlugin({
  anchorElem,
}: {
  anchorElem?: HTMLElement;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [modal, showModal] = useModal();
  const [queryString, setQueryString] = useState<string | null>(null);
  const [pluginDynamicOptions, setPluginDynamicOptions] = useState<TypeaheadMenuOption[]>([]);
  // Track contributions changes to re-render when extensions are loaded
  const [registryVersion, setRegistryVersion] = useState(0);

  // Ensure Material Symbols font is loaded
  useEffect(() => {
    ensureMaterialSymbolsLoaded();
  }, []);

  // Subscribe to extension contribution changes (e.g., when extensions load)
  useEffect(() => {
    return subscribeToExtensionContributions(() => {
      setRegistryVersion((v) => v + 1);
    });
  }, []);

  // Fetch dynamic options from plugins when query changes
  useEffect(() => {
    let cancelled = false;

    async function fetchPluginOptions() {
      if (!queryString) {
        setPluginDynamicOptions([]);
        return;
      }

      try {
        const dynamicOptions = await getAllExtensionDynamicOptions(queryString);
        if (!cancelled) {
          // Convert DynamicMenuOption to TypeaheadMenuOption
          const typeaheadOptions: TypeaheadMenuOption[] = dynamicOptions.map((opt) => ({
            id: opt.id,
            label: opt.label,
            icon: opt.icon ? <MaterialIcon name={opt.icon} /> : undefined,
            description: opt.description,
            keywords: opt.keywords || [],
            section: 'Plugins',
            onSelect: opt.onSelect,
          }));
          setPluginDynamicOptions(typeaheadOptions);
        }
      } catch (error) {
        console.error('[ComponentPickerPlugin] Error fetching dynamic options:', error);
      }
    }

    fetchPluginOptions();

    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const options = useMemo(() => {
    const baseOptions = getBaseOptions(editor, showModal);

    if (!queryString) {
      return baseOptions;
    }

    const regex = new RegExp(queryString, 'i');

    return [
      ...getDynamicOptions(editor, queryString),
      ...pluginDynamicOptions,
      ...baseOptions.filter(
        (option) =>
          regex.test(option.label) ||
          (option.keywords && option.keywords.some((keyword) => regex.test(keyword))),
      ),
    ];
  }, [editor, queryString, showModal, pluginDynamicOptions, registryVersion]);

  const triggerFn = useMemo(
    () => createBasicTriggerFunction('/', {minLength: 0}),
    [],
  );

  const handleQueryChange = useCallback((query: string | null) => {
    setQueryString(query);
  }, []);

  const handleSelectOption = useCallback(
    (
      option: TypeaheadMenuOption,
      _textNode: TextNode | null,
      closeMenu: () => void,
      _matchingString: string,
    ) => {
      option.onSelect();
      closeMenu();
    },
    [],
  );

  return (
    <>
      {modal}
      <TypeaheadMenuPlugin
        options={options}
        triggerFn={triggerFn}
        onQueryChange={handleQueryChange}
        onSelectOption={handleSelectOption}
        maxHeight={400}
        minWidth={300}
        maxWidth={400}
        anchorElem={anchorElem}
      />
    </>
  );
}
