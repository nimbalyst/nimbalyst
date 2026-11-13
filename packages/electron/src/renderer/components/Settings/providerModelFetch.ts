type LoadingUpdater = (prev: Record<string, boolean>) => Record<string, boolean>;

interface FetchProviderModelsOptions<M> {
  /**
   * Background refreshes (after a debounced settings save) keep the current
   * list on screen. Setting the loading flag makes provider panels unmount the
   * model list, which collapses the page and jumps the scroll position.
   */
  background?: boolean;
  setLoading: (updater: LoadingUpdater) => void;
  setAvailableModels: (grouped: Record<string, M[]>) => void;
  getAllModels: () => Promise<{ success: boolean; grouped?: Record<string, M[]> }>;
}

export async function fetchProviderModels<M>(
  provider: string,
  { background = false, setLoading, setAvailableModels, getAllModels }: FetchProviderModelsOptions<M>,
): Promise<void> {
  if (!background) {
    setLoading(prev => ({ ...prev, [provider]: true }));
  }
  try {
    const response = await getAllModels();
    if (response.success && response.grouped) {
      setAvailableModels(response.grouped);
    }
  } catch (error) {
    console.error(`Failed to fetch models for ${provider}:`, error);
  } finally {
    if (!background) {
      setLoading(prev => ({ ...prev, [provider]: false }));
    }
  }
}
