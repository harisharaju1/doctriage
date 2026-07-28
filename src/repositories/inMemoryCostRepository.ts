import type { CostRecord, CostRepository } from './costRepository.js';

export class InMemoryCostRepository implements CostRepository {
  private readonly entries: CostRecord[] = [];

  async record(entry: Omit<CostRecord, 'recordedAt'>): Promise<CostRecord> {
    const full: CostRecord = { ...entry, recordedAt: new Date() };
    this.entries.push(full);
    return full;
  }

  async list(): Promise<CostRecord[]> {
    return [...this.entries];
  }
}
