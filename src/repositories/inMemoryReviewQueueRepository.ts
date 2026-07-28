import type { ReviewQueueEntry, ReviewQueueRepository } from './reviewQueueRepository.js';

export class InMemoryReviewQueueRepository implements ReviewQueueRepository {
  private readonly store = new Map<string, ReviewQueueEntry>();

  async enqueue(entry: Omit<ReviewQueueEntry, 'queuedAt'>): Promise<ReviewQueueEntry> {
    const full: ReviewQueueEntry = { ...entry, queuedAt: new Date() };
    this.store.set(entry.documentId, full);
    return full;
  }

  async list(): Promise<ReviewQueueEntry[]> {
    return [...this.store.values()];
  }

  async findByDocumentId(documentId: string): Promise<ReviewQueueEntry | undefined> {
    return this.store.get(documentId);
  }

  async resolve(documentId: string): Promise<void> {
    this.store.delete(documentId);
  }
}
