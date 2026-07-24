/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {isDOMNode} from 'lexical';
import {ReactNode, useCallback, useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';

function PortalImpl({
  onClose,
  children,
  title,
  closeOnClickOutside,
}: {
  children: ReactNode;
  closeOnClickOutside: boolean;
  onClose: () => void;
  title: string;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (modalRef.current !== null) {
      modalRef.current.focus();
    }
  }, []);

  useEffect(() => {
    let modalOverlayElement: HTMLElement | null = null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const clickOutsideHandler = (event: MouseEvent) => {
      const target = event.target;
      if (
        modalRef.current !== null &&
        isDOMNode(target) &&
        !modalRef.current.contains(target) &&
        closeOnClickOutside
      ) {
        onClose();
      }
    };
    const modelElement = modalRef.current;
    if (modelElement !== null) {
      modalOverlayElement = modelElement.parentElement;
      if (modalOverlayElement !== null) {
        modalOverlayElement.addEventListener('click', clickOutsideHandler);
      }
    }

    window.addEventListener('keydown', handler);

    return () => {
      window.removeEventListener('keydown', handler);
      if (modalOverlayElement !== null) {
        modalOverlayElement?.removeEventListener('click', clickOutsideHandler);
      }
    };
  }, [closeOnClickOutside, onClose]);

  return (
    <div
      className="Modal__overlay flex justify-center items-center fixed flex-col inset-0 bg-black/60 z-[100]"
      role="dialog">
      <div
        className="Modal__modal p-5 min-h-[100px] min-w-[300px] flex flex-col relative rounded-[10px] bg-nim-secondary text-nim shadow-[0_0_20px_0_rgba(0,0,0,0.4)]"
        tabIndex={-1}
        ref={modalRef}>
        <h2 className="Modal__title text-nim m-0 pb-[10px] border-b border-nim">
          {title}
        </h2>
        <button
          className="Modal__closeButton border-0 absolute right-5 rounded-[20px] flex justify-center items-center w-[30px] h-[30px] text-center cursor-pointer bg-nim-tertiary text-nim hover:bg-nim-hover"
          aria-label="Close modal"
          type="button"
          onClick={onClose}>
          X
        </button>
        <div className="Modal__content pt-5">{children}</div>
      </div>
    </div>
  );
}

export default function Modal({
  onClose,
  children,
  title,
  closeOnClickOutside = false,
}: {
  children: ReactNode;
  closeOnClickOutside?: boolean;
  onClose: () => void;
  title: string;
}): JSX.Element {
  const getPortalContainer = useCallback(() => {
    // Try to find the nearest .nimbalyst-editor container
    const activeElement = document.activeElement;
    if (activeElement) {
      const editorContainer = activeElement.closest('.nimbalyst-editor');
      if (editorContainer) {
        return editorContainer;
      }
    }

    // Fallback: look for any .nimbalyst-editor container in the document
    const editorContainer = document.querySelector('.nimbalyst-editor');
    if (editorContainer) {
      return editorContainer;
    }

    // Final fallback: use document.body
    return document.body;
  }, []);

  return createPortal(
    <PortalImpl
      onClose={onClose}
      title={title}
      closeOnClickOutside={closeOnClickOutside}>
      {children}
    </PortalImpl>,
    getPortalContainer(),
  );
}
