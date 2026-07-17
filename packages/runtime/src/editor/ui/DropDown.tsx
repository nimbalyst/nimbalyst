/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {isDOMNode} from 'lexical';
import * as React from 'react';
import {
  type RefCallback,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
} from '@floating-ui/react';

type DropDownContextType = {
  registerItem: (ref: React.RefObject<HTMLButtonElement | null>) => void;
};

const DropDownContext = React.createContext<DropDownContextType | null>(null);
const dropDownPadding = 4;

export function DropDownItem({
  children,
  className,
  onClick,
  title,
}: {
  children: React.ReactNode;
  className: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  const dropDownContext = React.useContext(DropDownContext);

  if (dropDownContext === null) {
    throw new Error('DropDownItem must be used within a DropDown');
  }

  const {registerItem} = dropDownContext;

  useEffect(() => {
    if (ref && ref.current) {
      registerItem(ref);
    }
  }, [ref, registerItem]);

  return (
    <button
      className={className}
      onClick={onClick}
      ref={ref}
      title={title}
      type="button">
      {children}
    </button>
  );
}

function DropDownItems({
  children,
  dropDownRef,
  onClose,
  className,
  style,
  onClick,
  floatingProps,
}: {
  children: React.ReactNode;
  dropDownRef: React.Ref<HTMLDivElement>;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  floatingProps?: Record<string, unknown>;
}) {
  const [items, setItems] = useState<React.RefObject<HTMLButtonElement | null>[]>();
  const [highlightedItem, setHighlightedItem] =
    useState<React.RefObject<HTMLButtonElement | null>>();

  const registerItem = useCallback(
    (itemRef: React.RefObject<HTMLButtonElement | null>) => {
      setItems((prev) => (prev ? [...prev, itemRef] : [itemRef]));
    },
    [setItems],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!items) {
      return;
    }

    const key = event.key;

    if (['Escape', 'ArrowUp', 'ArrowDown', 'Tab'].includes(key)) {
      event.preventDefault();
    }

    if (key === 'Escape' || key === 'Tab') {
      onClose();
    } else if (key === 'ArrowUp') {
      setHighlightedItem((prev) => {
        if (!prev) {
          return items[0];
        }
        const index = items.indexOf(prev) - 1;
        return items[index === -1 ? items.length - 1 : index];
      });
    } else if (key === 'ArrowDown') {
      setHighlightedItem((prev) => {
        if (!prev) {
          return items[0];
        }
        return items[items.indexOf(prev) + 1];
      });
    }
  };

  const contextValue = useMemo(
    () => ({
      registerItem,
    }),
    [registerItem],
  );

  useEffect(() => {
    if (items && !highlightedItem) {
      setHighlightedItem(items[0]);
    }

    if (highlightedItem && highlightedItem.current) {
      highlightedItem.current.focus();
    }
  }, [items, highlightedItem]);

  return (
    <DropDownContext.Provider value={contextValue}>
      <div
        className={`dropdown ${className}` }
        ref={dropDownRef}
        style={style}
        {...floatingProps}
        onKeyDown={handleKeyDown}
        onClick={onClick}>
        {children}
      </div>
    </DropDownContext.Provider>
  );
}

export default function DropDown({
  disabled = false,
  buttonLabel,
  buttonAriaLabel,
  buttonClassName,
  buttonIconClassName,
  children,
  stopCloseOnClickSelf,
  className = '',
}: {
  disabled?: boolean;
  buttonAriaLabel?: string;
  buttonClassName: string;
  buttonIconClassName?: string;
  buttonLabel?: string;
  children: ReactNode;
  stopCloseOnClickSelf?: boolean;
  className?: string;
}): JSX.Element {
  const [buttonElement, setButtonElement] = useState<HTMLButtonElement | null>(null);
  const [showDropDown, setShowDropDown] = useState(false);
  const portalRoot =
    (buttonElement?.closest('.nimbalyst-editor') as HTMLElement | null) ?? null;
  const handleClose = useCallback(() => {
    setShowDropDown(false);
    if (buttonElement) {
      buttonElement.focus();
    }
  }, [buttonElement]);
  const {refs, floatingStyles, context} = useFloating({
    open: showDropDown,
    onOpenChange: (open) => {
      if (open) {
        setShowDropDown(true);
      } else {
        handleClose();
      }
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(dropDownPadding),
      flip({padding: 8}),
      shift({padding: 8}),
    ],
  });
  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, {role: 'menu'});
  const {getReferenceProps, getFloatingProps} = useInteractions([dismiss, role]);

  const setReferenceRef: RefCallback<HTMLButtonElement> = useCallback(
    (node) => {
      setButtonElement(node);
      refs.setReference(node);
    },
    [refs],
  );

  const setFloatingRef: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      refs.setFloating(node);
    },
    [refs],
  );

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={buttonAriaLabel || buttonLabel}
        className={buttonClassName}
        ref={setReferenceRef}
        {...getReferenceProps({
          onClick: () => setShowDropDown(!showDropDown),
        })}>
        {buttonIconClassName && <span className={buttonIconClassName} />}
        {buttonLabel && (
          <span className="text dropdown-button-text">{buttonLabel}</span>
        )}
        <i className="chevron-down" />
      </button>

      {showDropDown &&
        (
          <FloatingPortal root={portalRoot}>
            <DropDownItems
              dropDownRef={setFloatingRef}
              onClose={handleClose}
              className={className}
              style={floatingStyles}
              onClick={(event: React.MouseEvent<HTMLDivElement>) => {
                if (!isDOMNode(event.target)) {
                  return;
                }
                if (!stopCloseOnClickSelf) {
                  handleClose();
                }
              }}
              floatingProps={getFloatingProps()}>
              {children}
            </DropDownItems>
          </FloatingPortal>
        )}
    </>
  );
}
