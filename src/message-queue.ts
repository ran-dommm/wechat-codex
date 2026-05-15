export function enqueueQueuedMessage<T>(queue: T[], message: T): number {
  queue.push(message);
  return queue.length;
}

export function dequeueQueuedMessage<T>(queue: T[]): T | undefined {
  return queue.shift();
}

export function getQueuedMessageCount<T>(queue: T[]): number {
  return queue.length;
}
