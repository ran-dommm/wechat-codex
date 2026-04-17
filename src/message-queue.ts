export function enqueueQueuedMessage<T>(
  queues: Map<string, T[]>,
  accountId: string,
  message: T,
): number {
  const current = queues.get(accountId) ?? [];
  current.push(message);
  queues.set(accountId, current);
  return current.length;
}

export function dequeueQueuedMessage<T>(
  queues: Map<string, T[]>,
  accountId: string,
): T | undefined {
  const current = queues.get(accountId);
  if (!current?.length) {
    return undefined;
  }

  const next = current.shift();
  if (!current.length) {
    queues.delete(accountId);
  }
  return next;
}

export function getQueuedMessageCount<T>(
  queues: Map<string, T[]>,
  accountId: string,
): number {
  return queues.get(accountId)?.length ?? 0;
}
