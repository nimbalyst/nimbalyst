import React, { useState } from "react";
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { MaterialSymbol } from "@nimbalyst/runtime";
import type { ProviderCatalogControlValue } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog";

export interface CatalogControlDefinition {
  id: string;
  persistenceKey: string;
  displayLabel: string;
  helpText: string;
  allowedValues: readonly ProviderCatalogControlValue[];
  defaultValue: ProviderCatalogControlValue;
  valueLabels: Readonly<Record<string, string>>;
}

interface CatalogControlSelectorProps {
  control: CatalogControlDefinition;
  value: ProviderCatalogControlValue | null | undefined;
  onValueChange: (value: ProviderCatalogControlValue) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

function labelForValue(
  control: CatalogControlDefinition,
  value: ProviderCatalogControlValue
): string {
  return (
    control.valueLabels[JSON.stringify(value)] ??
    String(value)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

export function CatalogControlSelector({
  control,
  value,
  onValueChange,
  disabled = false,
  disabledTitle,
}: CatalogControlSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const listboxRef = React.useRef<HTMLDivElement>(null);
  const selectedValue = control.allowedValues.some((candidate) =>
    Object.is(candidate, value)
  )
    ? (value as ProviderCatalogControlValue)
    : control.defaultValue;
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "top-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "listbox" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    dismiss,
    role,
  ]);

  React.useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const setListboxReference = React.useCallback(
    (node: HTMLDivElement | null) => {
      refs.setFloating(node);
      listboxRef.current = node;
      if (node) {
        queueMicrotask(() => {
          if (listboxRef.current !== node) return;
          const options = Array.from(
            node.querySelectorAll<HTMLButtonElement>('[role="option"]')
          );
          (
            options.find(
              (option) => option.getAttribute("aria-selected") === "true"
            ) ?? options[0]
          )?.focus();
        });
      }
    },
    [refs]
  );

  const optionElements = React.useCallback(
    () =>
      Array.from(
        listboxRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="option"]'
        ) ?? []
      ) as HTMLButtonElement[],
    []
  );

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const options = optionElements();
    (
      options.find(
        (option) => option.getAttribute("aria-selected") === "true"
      ) ?? options[0]
    )?.focus();
  }, [isOpen, optionElements, selectedValue]);

  const closeAndRestoreFocus = React.useCallback(() => {
    setIsOpen(false);
    (refs.domReference.current as HTMLElement | null)?.focus();
  }, [refs]);

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = optionElements();
    const activeIndex = options.indexOf(
      document.activeElement as HTMLButtonElement
    );
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowDown"
          ? Math.min(options.length - 1, activeIndex + 1)
          : Math.max(0, activeIndex - 1);
      options[nextIndex]?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const activeOption = options[activeIndex];
      if (!activeOption) return;
      event.preventDefault();
      activeOption.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    }
  };

  return (
    <div
      className="catalog-control-selector inline-block"
      data-component="CatalogControlSelector"
      data-control-key={control.persistenceKey}
    >
      <button
        ref={refs.setReference}
        type="button"
        data-testid={`catalog-control-${control.persistenceKey}`}
        className={`catalog-control-selector-button flex items-center gap-1 rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-[3px] text-[11px] font-medium text-[var(--nim-text-muted)] outline-none transition-all duration-200 ${
          disabled
            ? "cursor-not-allowed opacity-45"
            : "cursor-pointer hover:border-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)]"
        }`}
        aria-label={`${control.displayLabel}: ${labelForValue(
          control,
          selectedValue
        )}`}
        aria-description={control.helpText}
        disabled={disabled}
        title={disabled ? disabledTitle : control.helpText}
        {...getReferenceProps({
          onClick: () => !disabled && setIsOpen((open) => !open),
          onKeyDown: (event) => {
            if (
              !disabled &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              setIsOpen(true);
            }
          },
        })}
      >
        <MaterialSymbol icon="psychology" size={12} />
        <span>
          {control.displayLabel}: {labelForValue(control, selectedValue)}
        </span>
        <MaterialSymbol
          icon="expand_more"
          size={14}
          className={`shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={setListboxReference}
            className="catalog-control-selector-menu z-[1000] min-w-[140px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            style={floatingStyles}
            data-testid={`catalog-control-${control.persistenceKey}-menu`}
            {...getFloatingProps({ onKeyDown: handleListboxKeyDown })}
          >
            {control.allowedValues.map((option) => {
              const selected = Object.is(option, selectedValue);
              return (
                <button
                  key={JSON.stringify(option)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className={`catalog-control-selector-option flex w-full cursor-pointer items-center justify-between gap-2 rounded border-none px-2 py-1.5 text-left text-xs transition-[background] duration-150 ${
                    selected
                      ? "bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]"
                      : "text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  }`}
                  onClick={() => {
                    onValueChange(option);
                    closeAndRestoreFocus();
                  }}
                >
                  <span>{labelForValue(control, option)}</span>
                  {selected && <MaterialSymbol icon="check" size={14} />}
                </button>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
