import type { InteractiveWidgetHost } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';

export function getDiffPeekSizeForInteractiveWidgetHost(
  host: InteractiveWidgetHost | null | undefined,
): InteractiveWidgetHost['diffPeekSize'] {
  return host?.diffPeekSize ?? null;
}
