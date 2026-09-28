/**
 * The Firestore composite indexes Terraform declares, parsed from the
 * state-deployment module, and the rule for whether they serve a query.
 *
 * Only a REAL project enforces composite indexes -- not the emulator, and
 * (until this file) not FakeFirestore -- so a query without its index passed
 * every test and failed live with 9 FAILED_PRECONDITION. That happened twice:
 * Week 1's official submissions list (see firestore.tf), and the 28 Sep
 * hotspot fast path (a range on uploadedAt with no orderBy sorts ASCENDING,
 * and only (h3Index, uploadedAt DESC) exists), which kept every citizen
 * report off the heatmap. FakeFirestore now checks each query against this.
 *
 * The parser knows exactly the two shapes the module uses (literal fields,
 * and the local.merge_indexes for_each) and throws on anything else, so a new
 * shape means updating this file -- never a silently weaker check.
 */
import { readdirSync, readFileSync } from 'node:fs';

export interface DeclaredIndex {
  /** Collection id (the last path segment), as Terraform declares it. */
  collection: string;
  fields: Array<{ path: string; dir: 'asc' | 'desc' }>;
}

export interface QueryShape {
  filters: Array<{ field: string; op: string }>;
  order?: { field: string; dir: 'asc' | 'desc' };
}

const MODULE_DIR = new URL('../../../../infra/terraform/modules/state-deployment/', import.meta.url);

/** Body of the `{ ... }` block opening at `open`. */
function blockAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('declaredIndexes: unbalanced braces');
}

export function terraformIndexes(dir: URL = MODULE_DIR): DeclaredIndex[] {
  const src = readdirSync(dir)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n')
    .replace(/^\s*(#|\/\/).*$/gm, ''); // full-line comments only; strings may contain "//"

  const localMap = (name: string): Array<Record<string, string>> => {
    const m = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(src);
    if (!m) throw new Error(`declaredIndexes: local.${name} not found`);
    const body = blockAt(src, m.index + m[0].length - 1);
    return [...body.matchAll(/\w+\s*=\s*\{([^{}]*)\}/g)].map((e) =>
      Object.fromEntries([...e[1]!.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1]!, a[2]!])),
    );
  };

  const out: DeclaredIndex[] = [];
  for (const m of src.matchAll(/resource\s+"google_firestore_index"\s+"(\w+)"\s*\{/g)) {
    const name = m[1]!;
    const body = blockAt(src, m.index! + m[0].length - 1);
    const fail = (why: string): never => {
      throw new Error(`declaredIndexes: google_firestore_index.${name}: ${why} -- teach packages/gcp-clients/src/testing/declaredIndexes.ts`);
    };
    if (/\b(query_scope|array_config|vector_config)\b/.test(body)) fail('unsupported attribute');
    const fields = [...body.matchAll(/fields\s*\{\s*field_path\s*=\s*(\S+)\s+order\s*=\s*"(ASCENDING|DESCENDING)"\s*\}/g)];
    if (fields.length < 2 || fields.length !== (body.match(/\bfields\s*\{/g) ?? []).length) fail('unrecognised fields blocks');
    const collection = /\bcollection\s*=\s*(\S+)/.exec(body)?.[1] ?? fail('no collection');
    const forEach = /\bfor_each\s*=\s*local\.(\w+)/.exec(body)?.[1];

    for (const entry of forEach ? localMap(forEach) : [{}]) {
      const value = (expr: string): string => {
        const literal = /^"([^"$]+)"$/.exec(expr)?.[1];
        if (literal) return literal;
        const key = /^each\.value\.(\w+)$/.exec(expr)?.[1];
        return (key && forEach && entry[key]) || fail(`cannot resolve ${expr}`);
      };
      out.push({
        collection: value(collection),
        fields: fields.map((f) => ({ path: value(f[1]!), dir: f[2] === 'ASCENDING' ? 'asc' : 'desc' })),
      });
    }
  }
  if (out.length === 0) throw new Error(`declaredIndexes: no google_firestore_index found under ${dir.pathname}`);
  return out;
}

/**
 * Undefined when `indexes` serve the query; otherwise the index it needs.
 * Firestore's rules, as far as VayuSetu uses them:
 *  - equality-only queries (==, in) merge single-field indexes: no composite;
 *  - one field, or a range + orderBy on that same field: single-field index;
 *  - equality on A (, B...) plus a sort on S -- an orderBy, or else the range
 *    field, which Firestore sorts ASCENDING -- needs indexes ending in S with
 *    THAT direction whose other fields are all equality-filtered. Indexes that
 *    share the suffix merge, so (A, S) + (B, S) serve A==, B==, orderBy S.
 */
export function missingIndex(collection: string, q: QueryShape, indexes: DeclaredIndex[]): string | undefined {
  const isEq = (op: string) => op === '==' || op === 'in';
  const eq = new Set(q.filters.filter((f) => isEq(f.op)).map((f) => f.field));
  const ranges = [...new Set(q.filters.filter((f) => !isEq(f.op)).map((f) => f.field))];
  if (ranges.length > 1) return `inequality filters on ${ranges.join(' and ')} (needs a composite index; none declared)`;
  if (q.order && ranges[0] && ranges[0] !== q.order.field) return `inequality on ${ranges[0]} ordered by ${q.order.field}`;
  const sort = q.order ?? (ranges[0] ? { field: ranges[0], dir: 'asc' as const } : undefined);
  if (!sort) return undefined;
  eq.delete(sort.field);
  if (eq.size === 0) return undefined;

  const covered = new Set<string>();
  for (const ix of indexes) {
    const last = ix.fields[ix.fields.length - 1]!;
    const prefix = ix.fields.slice(0, -1).map((f) => f.path);
    if (ix.collection === collection && last.path === sort.field && last.dir === sort.dir && prefix.every((p) => eq.has(p))) {
      for (const p of prefix) covered.add(p);
    }
  }
  if ([...eq].every((f) => covered.has(f))) return undefined;
  return `${collection} (${[...eq].map((f) => `${f} ASC`).join(', ')}, ${sort.field} ${sort.dir.toUpperCase()})`;
}
