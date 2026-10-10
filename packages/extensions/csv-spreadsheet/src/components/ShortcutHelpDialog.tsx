/**
 * Keyboard shortcut sheet (Cmd+/ or Ctrl+/). Lists what the grid key
 * controller and sheet shortcuts handle, with the platform's modifier name.
 */

import { useEffect, useRef } from 'react';
import { SHORTCUT_SHEET } from '../keyboard/sheetShortcuts';

export function ShortcutHelpDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);
  if (!isOpen) return null;
  const mod = /mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl';

  return (
    <div className="csv-shortcut-dialog fixed inset-0 bg-black/40 flex items-center justify-center z-[2000]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="bg-nim border border-nim rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.24)] w-[560px] max-h-[80vh] overflow-auto outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nim">
          <h3 className="m-0 text-base font-semibold text-nim">Keyboard shortcuts</h3>
          <button className="bg-none border-none text-xl text-nim-muted cursor-pointer p-0 leading-none hover:text-nim" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-4 select-text">
          {SHORTCUT_SHEET.map(({ group, items }) => (
            <section key={group}>
              <h4 className="m-0 mb-2 text-[12px] font-semibold uppercase text-nim-muted">{group}</h4>
              <dl className="m-0 flex flex-col gap-1">
                {items.map(([keys, action]) => (
                  <div key={keys} className="flex justify-between gap-3 text-[12px]">
                    <dt className="text-nim">{action}</dt>
                    <dd className="m-0 text-nim-muted whitespace-nowrap">{keys.replace(/mod/g, mod)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
