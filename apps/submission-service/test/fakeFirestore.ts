/**
 * A minimal, in-memory stand-in for the slice of the Firestore API this
 * service actually calls (doc get/set, where/orderBy/limit/startAfter
 * queries). NOT a Firestore emulator replacement -- it doesn't enforce
 * real index requirements, transactions, or Firestore's actual query
 * planner semantics. It exists purely so routes/*.ts's own logic
 * (authorization, validation, status transitions) can be unit-tested in
 * milliseconds without a live emulator process. Integration coverage
 * against the real thing still belongs to Engineer 4's contract-test
 * suite (Week 2) running against the actual Firestore emulator.
 */

type DocData = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    private readonly _data: DocData | undefined,
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): DocData | undefined {
    return this._data;
  }
}

class FakeDocRef {
  constructor(
    private readonly store: Map<string, DocData>,
    public readonly id: string,
  ) {}
  async get(): Promise<FakeDocSnapshot> {
    return new FakeDocSnapshot(this.id, this.store.get(this.id));
  }
  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
    if (opts?.merge) {
      this.store.set(this.id, { ...(this.store.get(this.id) ?? {}), ...data });
    } else {
      this.store.set(this.id, { ...data });
    }
  }
}

interface Filter {
  field: string;
  op: '==';
  value: unknown;
}
interface Order {
  field: string;
  dir: 'asc' | 'desc';
}

class FakeQuery {
  constructor(
    private readonly store: Map<string, DocData>,
    private readonly filters: Filter[] = [],
    private readonly order?: Order,
    private readonly limitN?: number,
    private readonly cursor?: unknown,
  ) {}

  where(field: string, op: '==', value: unknown): FakeQuery {
    return new FakeQuery(this.store, [...this.filters, { field, op, value }], this.order, this.limitN, this.cursor);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store, this.filters, { field, dir }, this.limitN, this.cursor);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.order, n, this.cursor);
  }
  startAfter(value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.order, this.limitN, value);
  }

  async get(): Promise<{ docs: FakeDocSnapshot[] }> {
    let rows = [...this.store.entries()].map(([id, data]) => ({ id, data }));

    for (const f of this.filters) {
      rows = rows.filter((r) => getPath(r.data, f.field) === f.value);
    }

    if (this.order) {
      const { field, dir } = this.order;
      rows.sort((a, b) => {
        const av = String(getPath(a.data, field) ?? '');
        const bv = String(getPath(b.data, field) ?? '');
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === 'asc' ? cmp : -cmp;
      });
    }

    if (this.cursor !== undefined && this.order) {
      const { field, dir } = this.order;
      rows = rows.filter((r) => {
        const v = String(getPath(r.data, field) ?? '');
        const c = String(this.cursor);
        return dir === 'desc' ? v < c : v > c;
      });
    }

    if (this.limitN !== undefined) rows = rows.slice(0, this.limitN);

    return { docs: rows.map((r) => new FakeDocSnapshot(r.id, r.data)) };
  }
}

class FakeCollection {
  private readonly store = new Map<string, DocData>();
  private autoIdCounter = 0;

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.store, id ?? `auto-${++this.autoIdCounter}`);
  }
  where(field: string, op: '==', value: unknown): FakeQuery {
    return new FakeQuery(this.store).where(field, op, value);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store).orderBy(field, dir);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.store).limit(n);
  }

  /** Test-only helper -- not part of the real Firestore API. */
  seed(id: string, data: DocData): void {
    this.store.set(id, data);
  }
}

export class FakeFirestore {
  private readonly collections = new Map<string, FakeCollection>();

  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
    return this.collections.get(name)!;
  }
}
