import { createContext, useContext } from 'react';

export interface FrontmatterUtils {
  $getFrontmatter: () => any;
  $setFrontmatter: (data: any) => void;
}

const FrontmatterContext = createContext<FrontmatterUtils | null>(null);

export const FrontmatterProvider = FrontmatterContext.Provider;

export function useFrontmatterUtils(): FrontmatterUtils {
  const utils = useContext(FrontmatterContext);
  if (!utils) {
    // Return default implementations that do nothing
    // This allows plugins to work even without frontmatter support
    return {
      $getFrontmatter: () => ({}),
      $setFrontmatter: () => {}
    };
  }
  return utils;
}