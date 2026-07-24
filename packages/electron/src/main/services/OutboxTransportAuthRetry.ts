export class OutboxUpgradeRejectedError extends Error {
  constructor(readonly statusCode: number) {
    super(`Outbox drain WebSocket rejected with HTTP ${statusCode}`);
    this.name = "OutboxUpgradeRejectedError";
  }
}

/** Upgrade 403 is usually stale auth; force a fresh org JWT exactly once. */
export async function retryOutboxConnectAfterAuthRejection<T>(
  connect: (forceRefresh: boolean) => Promise<T>
): Promise<T> {
  try {
    return await connect(false);
  } catch (error) {
    if (!(error instanceof OutboxUpgradeRejectedError) || error.statusCode !== 403) {
      throw error;
    }
    return connect(true);
  }
}
