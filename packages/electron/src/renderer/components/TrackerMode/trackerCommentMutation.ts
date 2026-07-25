export type TrackerCommentInvoke = (
  channel: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export async function invokeTrackerCommentMutation(
  invoke: TrackerCommentInvoke,
  channel: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const result = await invoke(channel, payload) as any;
  if (!result?.success) {
    throw new Error(result?.error || 'Tracker comment update failed');
  }
  return result;
}
