/**
 * In-memory stand-in for the slice of the Firestore Admin API VayuSetu's
 * services call. Test-only: import from '@vayusetu/gcp-clients/testing'.
 *
 * What it does NOT model -- so passing unit tests prove nothing about these:
 *   - composite-index requirements (neither does the Firestore EMULATOR --
 *     only the real project enforces them; see WEEK2_SETUP.md)
 *   - transaction contention/retries (transactions run serially here)
 *   - FieldValue sentinels (serverTimestamp, arrayUnion, ...)
 * Error codes mirror gRPC: create() on an existing doc throws code 6
 * (ALREADY_EXISTS); update() on a missing doc throws code 5 (NOT_FOUND).
 */

type DocData = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    private readonly _data: DocData | undefined,
    public readonly ref: FakeDocRef,
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): DocData | undefined {
    return clone(this._data);
  }
}

export class FakeDocRef {
  constructor(
    private readonly store: Map<string, DocData>,
    public readonly id: string,
  ) {}
  async get(): Promise<FakeDocSnapshot> {
    return new FakeDocSnapshot(this.id, this.store.get(this.id), this);
  }
  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
    const base = opts?.merge ? (this.store.get(this.id) ?? {}) : {};
    this.store.set(this.id, clone({ ...base, ...data }));
  }
  async create(data: DocData): Promise<void> {
    if (this.store.has(this.id)) throw grpcError(6, `ALREADY_EXISTS: ${this.id}`);
    this.store.set(this.id, clone(data));
  }
  async update(data: DocData): Promise<void> {
    const existing = this.store.get(this.id);
    if (!existing) throw grpcError(5, `NOT_FOUND: ${this.id}`);
    this.store.set(this.id, clone({ ...existing, ...data }));
  }
}

type Op = '==' | 'in' | '<' | '<=' | '>' | '>=';
interface Filter {
  field: string;
  op: Op;
  value: unknown;
}
interface Order {
  field: string;
  dir: 'asc' | 'desc';
}

export class FakeQuery {
  constructor(
    protected readonly store: Map<string, DocData>,
    private readonly filters: Filter[] = [],
    private readonly order?: Order,
    private readonly limitN?: number,
    private readonly cursor?: unknown,
  ) {}

  where(field: string, op: Op, value: unknown): FakeQuery {
    return new FakeQuery(this.store, [...this.filters, { field, op, value }], this.order, this.limitN, this.cursor);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store, this.filters, { field, dir }, this.limitN, this.cursor);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.order, n, this.cursor);
  }
  startAfter(cursor: unknown): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.order, this.limitN, cursor);
  }
  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    return {
      get: async () => {
        const n = this.filtered().length;
        return { data: () => ({ count: n }) };
      },
    };
  }

  private filtered(): Array<{ id: string; data: DocData }> {
    let rows = [...this.store.entries()].map(([id, data]) => ({ id, data }));
    for (const f of this.filters) {
      rows = rows.filter((r) => {
        const v = getPath(r.data, f.field);
        switch (f.op) {
          case 'in':
            return (f.value as unknown[]).includes(v);
          case '==':
            return v === f.value;
          default: {
            // Range filters: like Firestore, a doc lacking the field never matches.
            if (v === undefined || v === null) return false;
            const [a, b] = [v as string | number, f.value as string | number];
            return f.op === '<' ? a < b : f.op === '<=' ? a <= b : f.op === '>' ? a > b : a >= b;
          }
        }
      });
    }
    return rows;
  }

  async get(): Promise<{ docs: FakeDocSnapshot[]; empty: boolean; size: number }> {
    let rows = this.filtered();

    if (this.order) {
      const { field, dir } = this.order;
      rows.sort((a, b) => {
        const av = String(getPath(a.data, field) ?? '');
        const bv = String(getPath(b.data, field) ?? '');
        // Tie-break on doc id, matching Firestore's implicit __name__ ordering.
        const cmp = av < bv ? -1 : av > bv ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return dir === 'asc' ? cmp : -cmp;
      });
    }

    if (this.cursor instanceof FakeDocSnapshot) {
      const cursorId = this.cursor.id;
      const idx = rows.findIndex((r) => r.id === cursorId);
      rows = idx >= 0 ? rows.slice(idx + 1) : rows;
    } else if (this.cursor !== undefined && this.order) {
      const { field, dir } = this.order;
      const c = String(this.cursor);
      rows = rows.filter((r) => {
        const v = String(getPath(r.data, field) ?? '');
        return dir === 'desc' ? v < c : v > c;
      });
    }

    if (this.limitN !== undefined) rows = rows.slice(0, this.limitN);
    const docs = rows.map((r) => new FakeDocSnapshot(r.id, r.data, new FakeDocRef(this.store, r.id)));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

export class FakeCollection extends FakeQuery {
  private autoIdCounter = 0;

  constructor(store: Map<string, DocData>) {
    super(store);
  }

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.store, id ?? `auto-${String(++this.autoIdCounter).padStart(6, '0')}`);
  }

  /** Test-only helper -- not part of the real Firestore API. */
  seed(id: string, data: DocData): void {
    this.store.set(id, clone(data));
  }

  /** Test-only helper. */
  all(): Array<{ id: string; data: DocData }> {
    return [...this.store.entries()].map(([id, data]) => ({ id, data: clone(data) }));
  }
}

export interface FakeTransaction {
  get(target: FakeDocRef): Promise<FakeDocSnapshot>;
  get(target: FakeQuery): Promise<{ docs: FakeDocSnapshot[] }>;
  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }): FakeTransaction;
  update(ref: FakeDocRef, data: DocData): FakeTransaction;
  create(ref: FakeDocRef, data: DocData): FakeTransaction;
}

export class FakeFirestore {
  private readonly collections = new Map<string, FakeCollection>();

  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(new Map()));
    return this.collections.get(name)!;
  }

  /** Writes are buffered and applied after `fn` resolves, like the real SDK
   *  (reads-before-writes). Runs serially, so it never retries. */
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const writes: Array<() => Promise<void>> = [];
    const tx: FakeTransaction = {
      get: ((target: FakeDocRef | FakeQuery) => target.get()) as FakeTransaction['get'],
      set(ref, data, opts) {
        writes.push(() => ref.set(data, opts));
        return tx;
      },
      update(ref, data) {
        writes.push(() => ref.update(data));
        return tx;
      },
      create(ref, data) {
        writes.push(() => ref.create(data));
        return tx;
      },
    };
    const result = await fn(tx);
    for (const w of writes) await w();
    return result;
  }

  reset(): void {
    this.collections.clear();
  }
}
