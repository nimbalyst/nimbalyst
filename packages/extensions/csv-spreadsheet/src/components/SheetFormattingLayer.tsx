/**
 * The floating and modal Phase 3 surfaces over the grid: the validation
 * dropdown and rejection message, the validation rule dialog, and the named
 * ranges dialog.
 */

import type { SheetChrome } from '../editor/useSheetChrome';
import { ValidationDropdown, ValidationMessage } from './ValidationPopovers';
import { ValidationDialog } from './ValidationDialog';
import { NamedRangesDialog } from './NamedRangesDialog';
import type { EditorCore } from '../editor/editorCore';
import type { NamedRanges } from '../sheetMeta/namedRanges';

export function SheetFormattingLayer({ chrome, core, namedRanges }: { chrome: SheetChrome; core: EditorCore; namedRanges: NamedRanges }) {
  const { validationUi } = chrome;
  return (
    <>
      {validationUi.dropdown && (
        <ValidationDropdown
          key={`${validationUi.dropdown.row}:${validationUi.dropdown.col}`}
          rect={validationUi.dropdown.rect}
          options={validationUi.dropdown.options}
          value={validationUi.dropdown.value}
          onPick={validationUi.pick}
          onClose={validationUi.closeDropdown}
        />
      )}
      {validationUi.rejection && (
        <ValidationMessage rect={validationUi.rejection.rect} message={validationUi.rejection.message} onClose={validationUi.closeRejection} />
      )}
      <ValidationDialog
        isOpen={chrome.validationOpen}
        rangeLabel={chrome.selectionKey}
        current={chrome.currentRule}
        onSave={chrome.saveValidation}
        onClose={() => chrome.setValidationOpen(false)}
      />
      <NamedRangesDialog
        core={core}
        isOpen={chrome.namedRangesOpen}
        names={namedRanges}
        selectionKey={chrome.selectionKey}
        onClose={() => chrome.setNamedRangesOpen(false)}
      />
    </>
  );
}
