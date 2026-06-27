import type { DocumentRecord, DocumentRepository } from './documentRepository.js';

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly store = new Map<string, DocumentRecord>();

  async save(record: DocumentRecord): Promise<void> {
    this.store.set(record.documentId, record);
  }

  async findById(documentId: string): Promise<DocumentRecord | undefined> {
    return this.store.get(documentId);
  }
}
