import { createInitialState, moveProduct, type Buyer, type Product } from "./crm";
import type { CrmRepository } from "./crm-repository";

/** Each demo owns its data in memory. No accounts, network or persistent storage. */
export function createDemoRepository(): CrmRepository {
  let state = createInitialState();
  const copy = <T,>(value: T): T => structuredClone(value);
  function find<T extends { id: string }>(rows: T[], id: string): T {
    const row = rows.find((item) => item.id === id);
    if (!row) throw new Error("Запись не найдена в демо.");
    return row;
  }
  function save<T extends Product | Buyer>(rows: T[], row: T, existing: boolean): T[] {
    if (existing) find(rows, row.id);
    return existing ? rows.map((item) => item.id === row.id ? copy(row) : item) : [...rows, copy(row)];
  }
  return {
    async load() { return copy(state); },
    async saveProduct(product, existing) {
      state.products = save(state.products, product, existing);
      return copy(product);
    },
    async changeProductStage(id, stage, soldAt) {
      find(state.products, id);
      state = moveProduct(state, id, stage, soldAt ?? new Date().toISOString());
      return copy(find(state.products, id));
    },
    async saveBuyer(buyer, existing) {
      state.buyers = save(state.buyers, buyer, existing);
      return copy(buyer);
    },
    async updateBuyerStatus(id, status) {
      const buyer = { ...find(state.buyers, id), status };
      state.buyers = save(state.buyers, buyer, true);
      return copy(buyer);
    },
    async addMessage(message) {
      find(state.buyers, message.buyerId);
      if (!state.messages.some((item) => item.id === message.id)) state.messages.push(copy(message));
      return copy(message);
    },
    async markBuyerMessagesRead(id) {
      state.messages = state.messages.map((item) => item.buyerId === id && item.direction === "incoming" ? { ...item, read: true } : item);
    },
  };
}
