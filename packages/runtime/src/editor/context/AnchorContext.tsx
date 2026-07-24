import React, { createContext, useContext } from 'react';

export const AnchorContext = createContext<HTMLElement | null>(null);

export function useAnchorElem(): HTMLElement | null {
  return useContext(AnchorContext);
}

export const AnchorProvider = AnchorContext.Provider;

