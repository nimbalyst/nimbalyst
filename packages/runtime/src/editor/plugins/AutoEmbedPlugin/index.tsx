/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';
import type {JSX} from 'react';

import {
  AutoEmbedOption,
  EmbedConfig,
  EmbedMatchResult,
  LexicalAutoEmbedPlugin,
  URL_MATCHER,
} from '@lexical/react/LexicalAutoEmbedPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {COMMAND_PRIORITY_EDITOR} from 'lexical';
import {useCallback, useEffect, useMemo, useState} from 'react';
import * as ReactDOM from 'react-dom';

import {
  EXTERNAL_EMBED_PROVIDERS,
  parseWebUrl,
  resolveExternalEmbed,
} from '../LinkPreviewPlugin/externalEmbeds';
import {
  $insertLinkPreview,
  $isPastedLinkAlone,
  INSERT_LINK_PREVIEW_COMMAND,
} from '../LinkPreviewPlugin/linkPreviewInsert';
import {
  defaultLinkPreviewMode,
  type LinkPreviewMode,
} from '../LinkPreviewPlugin/linkPreviewLinks';

import useModal from '../../hooks/useModal';
import Button from '../../ui/Button';
import {DialogActions} from '../../ui/Dialog';

interface PlaygroundEmbedConfig extends EmbedConfig {
  // Human readable name of the embedded content e.g. Tweet or Google Map.
  contentName: string;

  // Icon for display.
  icon?: JSX.Element;

  // An example of a matching url https://twitter.com/jack/status/20
  exampleUrl: string;

  // For extra searching.
  keywords: Array<string>;

  // Embed a Figma Project.
  description?: string;
}

/**
 * Any http(s) link: offered as a preview card. Listed first because the
 * paste listener keeps the LAST config that matches, so an allowlisted
 * provider below wins and its menu offers both the player and the card.
 */
export const LinkPreviewEmbedConfig: PlaygroundEmbedConfig = {
  contentName: 'Link preview',
  exampleUrl: 'https://example.com/article',
  keywords: ['link', 'preview', 'bookmark', 'card', 'embed', 'url'],
  parseUrl: (url: string) => (parseWebUrl(url) ? { id: url, url } : null),
  insertNode: (_editor: LexicalEditor, result: EmbedMatchResult) => {
    $insertLinkPreview(result.url, takeRequestedMode() ?? defaultLinkPreviewMode(result.url) ?? 'card');
  },
  type: 'link-preview',
};

/**
 * The configs the paste listener matches against. Each one only matches a
 * link that sits alone in its paragraph: a URL pasted into a sentence stays a
 * link without a menu.
 */
function createPasteEmbedConfigs(editor: LexicalEditor): PlaygroundEmbedConfig[] {
  const alone = (url: string) => editor.getEditorState().read(() => $isPastedLinkAlone(url));
  return [
    {
      ...LinkPreviewEmbedConfig,
      parseUrl: (url: string) => (parseWebUrl(url) && alone(url) ? { id: url, url } : null),
    },
    // One per allowlisted site (`externalEmbeds.ts`).
    ...EXTERNAL_EMBED_PROVIDERS.map(({ provider, contentName }) => ({
      contentName,
      exampleUrl: '',
      keywords: [provider, 'embed', 'video'],
      parseUrl: (url: string) => (resolveExternalEmbed(url)?.provider === provider && alone(url) ? { id: url, url } : null),
      insertNode: (_editor: LexicalEditor, result: EmbedMatchResult) => {
        $insertLinkPreview(result.url, takeRequestedMode() ?? 'embed');
      },
      type: `embed-${provider}`,
    })),
  ];
}

/**
 * The upstream plugin calls `insertNode` with the match result only, so the
 * menu option records which presentation was picked here first.
 */
let requestedMode: LinkPreviewMode | null = null;
function takeRequestedMode(): LinkPreviewMode | null {
  const mode = requestedMode;
  requestedMode = null;
  return mode;
}

function AutoEmbedMenuItem({
  index,
  isSelected,
  onClick,
  onMouseEnter,
  option,
}: {
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  option: AutoEmbedOption;
}) {
  let className = 'item';
  if (isSelected) {
    className += ' selected';
  }
  return (
    <li
      key={option.key}
      tabIndex={-1}
      className={className}
      ref={option.setRefElement}
      role="option"
      aria-selected={isSelected}
      id={'typeahead-item-' + index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}>
      <span className="text">{option.title}</span>
    </li>
  );
}

function AutoEmbedMenu({
  options,
  selectedItemIndex,
  onOptionClick,
  onOptionMouseEnter,
}: {
  selectedItemIndex: number | null;
  onOptionClick: (option: AutoEmbedOption, index: number) => void;
  onOptionMouseEnter: (index: number) => void;
  options: Array<AutoEmbedOption>;
}) {
  return (
    <div className="typeahead-popover">
      <ul>
        {options.map((option: AutoEmbedOption, i: number) => (
          <AutoEmbedMenuItem
            index={i}
            isSelected={selectedItemIndex === i}
            onClick={() => onOptionClick(option, i)}
            onMouseEnter={() => onOptionMouseEnter(i)}
            key={option.key}
            option={option}
          />
        ))}
      </ul>
    </div>
  );
}

const debounce = (callback: (text: string) => void, delay: number) => {
  let timeoutId: number;
  return (text: string) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback(text);
    }, delay);
  };
};

export function AutoEmbedDialog({
  embedConfig,
  onClose,
}: {
  embedConfig: PlaygroundEmbedConfig;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [editor] = useLexicalComposerContext();
  const [embedResult, setEmbedResult] = useState<EmbedMatchResult | null>(null);

  const validateText = useMemo(
    () =>
      debounce((inputText: string) => {
        const urlMatch = URL_MATCHER.exec(inputText);
        if (embedConfig != null && inputText != null && urlMatch != null) {
          Promise.resolve(embedConfig.parseUrl(inputText)).then(
            (parseResult) => {
              setEmbedResult(parseResult);
            },
          );
        } else if (embedResult != null) {
          setEmbedResult(null);
        }
      }, 200),
    [embedConfig, embedResult],
  );

  const onClick = () => {
    if (embedResult != null) {
      editor.update(() => embedConfig.insertNode(editor, embedResult));
      onClose();
    }
  };
  // Enter can beat the debounced check, so it parses the text itself.
  const submit = async () => {
    const result = embedResult
      ?? (URL_MATCHER.exec(text) ? await Promise.resolve(embedConfig.parseUrl(text)) : null);
    if (result == null) return;
    editor.update(() => embedConfig.insertNode(editor, result));
    onClose();
  };

  return (
    <div className="auto-embed-dialog w-[min(600px,80vw)]">
      <div className="Input__wrapper mb-[10px]">
        <input
          type="text"
          className="Input__input w-full rounded-[5px] border border-nim bg-nim-secondary px-[10px] py-[7px] text-base text-nim placeholder:text-nim-faint focus:border-[var(--nim-border-focus)] focus:outline-none dark:[color-scheme:dark]"
          placeholder={embedConfig.exampleUrl}
          value={text}
          autoFocus
          spellCheck={false}
          data-test-id={`${embedConfig.type}-embed-modal-url`}
          onChange={(e) => {
            const {value} = e.target;
            setText(value);
            validateText(value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <DialogActions>
        <Button
          disabled={!embedResult}
          onClick={onClick}
          data-test-id={`${embedConfig.type}-embed-modal-submit-btn`}>
          Embed
        </Button>
      </DialogActions>
    </div>
  );
}

export default function AutoEmbedPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [modal, showModal] = useModal();
  const pasteEmbedConfigs = useMemo(() => createPasteEmbedConfigs(editor), [editor]);

  const openEmbedModal = useCallback((embedConfig: PlaygroundEmbedConfig) => {
    showModal(embedConfig.contentName, (onClose) => (
      <AutoEmbedDialog embedConfig={embedConfig} onClose={onClose} />
    ));
  }, [showModal]);

  useEffect(
    () => editor.registerCommand(
      INSERT_LINK_PREVIEW_COMMAND,
      () => {
        openEmbedModal(LinkPreviewEmbedConfig);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    [editor, openEmbedModal],
  );

  const getMenuOptions = (
    activeEmbedConfig: PlaygroundEmbedConfig,
    embedFn: () => void,
    dismissFn: () => void,
  ) => {
    const pick = (mode: LinkPreviewMode) => () => {
      requestedMode = mode;
      embedFn();
    };
    const options = [
      new AutoEmbedOption('Keep as link', {
        onSelect: dismissFn,
      }),
    ];
    if (activeEmbedConfig.type !== LinkPreviewEmbedConfig.type) {
      options.push(new AutoEmbedOption(`Embed ${activeEmbedConfig.contentName}`, { onSelect: pick('embed') }));
    }
    options.push(new AutoEmbedOption('Preview card', { onSelect: pick('card') }));
    return options;
  };

  return (
    <>
      {modal}
      <LexicalAutoEmbedPlugin<PlaygroundEmbedConfig>
        embedConfigs={pasteEmbedConfigs}
        onOpenEmbedModalForConfig={openEmbedModal}
        getMenuOptions={getMenuOptions}
        menuRenderFn={(
          anchorElementRef,
          {selectedIndex, options, selectOptionAndCleanUp, setHighlightedIndex},
        ) =>
          anchorElementRef.current
            ? ReactDOM.createPortal(
                <div
                  className="typeahead-popover auto-embed-menu"
                  style={{
                    marginLeft: `${Math.max(
                      parseFloat(anchorElementRef.current.style.width) - 200,
                      0,
                    )}px`,
                    width: 200,
                  }}>
                  <AutoEmbedMenu
                    options={options}
                    selectedItemIndex={selectedIndex}
                    onOptionClick={(option: AutoEmbedOption, index: number) => {
                      setHighlightedIndex(index);
                      selectOptionAndCleanUp(option);
                    }}
                    onOptionMouseEnter={(index: number) => {
                      setHighlightedIndex(index);
                    }}
                  />
                </div>,
                anchorElementRef.current,
              )
            : null
        }
      />
    </>
  );
}
