import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createGenerator } from 'ts-json-schema-generator';

/**
 * docs/api/openapi.yaml must agree with:
 *   - packages/shared-types (every component schema, structurally),
 *   - docs/context/03_API_CONTRACTS.md 4.2 (the 25 operations, their success
 *     and error codes),
 *   - packages/config/api-routes.json (which service owns each path).
 * Any drift in any of the four fails CI.
 */
const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(file(rel), 'utf-8').replace(/\r\n/g, '\n');

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec = parse(read('../../../docs/api/openapi.yaml')) as Json;
const contractDoc = read('../../../docs/context/03_API_CONTRACTS.md');
const routes = JSON.parse(read('../../config/api-routes.json')) as { services: Record<string, { prefixes: string[] }> };

// ---------------------------------------------------------------- canonical form
// Both JSON Schema dialects are reduced to the facts the contract fixes:
// type, enum values, property names, required-ness, item/value types.
// Formats, bounds, descriptions and examples are documentation, not shape.
type Canon =
  | { k: 'any' }
  | { k: 'scalar'; t: string; enum?: Array<string | number> }
  | { k: 'object'; props: Record<string, Canon>; req: string[]; values?: Canon }
  | { k: 'array'; items: Canon }
  | { k: 'union'; of: Canon[] };

function resolve(root: Json, ref: string): Json {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => {
      if (!(key in node)) throw new Error(`unresolvable $ref ${ref}`);
      return node[key];
    }, root);
}

function canon(s: Json, root: Json): Canon {
  if (s.$ref) return canon(resolve(root, s.$ref), root);
  const variants = s.anyOf ?? s.oneOf;
  if (variants) {
    const parts = (variants as Json[]).map((v) => canon(v, root));
    // 'a' | 'b' | RefToStringEnum -> one string enum
    if (parts.every((p) => p.k === 'scalar' && p.t === 'string' && p.enum)) {
      const all = parts.flatMap((p) => (p as { enum: string[] }).enum);
      return { k: 'scalar', t: 'string', enum: [...new Set(all)].sort() };
    }
    return { k: 'union', of: parts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  }
  if (s.const !== undefined) return { k: 'scalar', t: typeof s.const, enum: [s.const] };
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (!type) return { k: 'any' };
  if (type === 'object') {
    const props = Object.fromEntries(Object.entries((s.properties ?? {}) as Json).map(([k, v]) => [k, canon(v as Json, root)]));
    const values = s.additionalProperties && typeof s.additionalProperties === 'object' ? canon(s.additionalProperties, root) : undefined;
    return { k: 'object', props, req: [...((s.required as string[]) ?? [])].sort(), ...(values ? { values } : {}) };
  }
  if (type === 'array') return { k: 'array', items: canon(s.items ?? {}, root) };
  const t = type === 'integer' ? 'number' : type;
  return { k: 'scalar', t, ...(s.enum ? { enum: [...s.enum].sort() } : {}) };
}

/** Paths where two canonical forms differ, e.g. `props.phoneNumber: missing in spec`. */
function diff(fromSpec: unknown, fromTs: unknown, at = ''): string[] {
  if (JSON.stringify(fromSpec) === JSON.stringify(fromTs)) return [];
  if (fromSpec && fromTs && typeof fromSpec === 'object' && typeof fromTs === 'object' && !Array.isArray(fromSpec)) {
    const keys = new Set([...Object.keys(fromSpec), ...Object.keys(fromTs)]);
    return [...keys].flatMap((k) => {
      const [a, b] = [(fromSpec as Json)[k], (fromTs as Json)[k]];
      if (a === undefined) return [`${at}${k}: missing in spec`];
      if (b === undefined) return [`${at}${k}: not in shared-types`];
      return diff(a, b, `${at}${k}.`);
    });
  }
  return [`${at.slice(0, -1)}: spec ${JSON.stringify(fromSpec)} vs shared-types ${JSON.stringify(fromTs)}`];
}

// ---------------------------------------------------------------- the contract doc's endpoints
interface DocEndpoint {
  method: string;
  path: string;
  codes: string[];
}

function contractEndpoints(): DocEndpoint[] {
  const section = contractDoc.split('## 4.2')[1]!.split('## 4.3')[0]!;
  const out: DocEndpoint[] = [];
  for (const m of section.matchAll(/^- \*\*`(GET|POST|PATCH|PUT|DELETE) ([^`]+)`\*\*(.*)$/gm)) {
    const body = m[3]!;
    const success = [...body.matchAll(/Response `(\d{3})`/g)].map((x) => x[1]!);
    const errors = [...(body.split('Errors:')[1] ?? '').matchAll(/`(\d{3})`/g)].map((x) => x[1]!);
    out.push({
      method: m[1]!.toLowerCase(),
      path: m[2]!.replace(/:(\w+)/g, '{$1}'),
      codes: [...new Set([...success, ...errors])].sort(),
    });
  }
  return out;
}

function specOperations() {
  const methods = ['get', 'post', 'patch', 'put', 'delete'];
  return Object.entries(spec.paths as Json).flatMap(([path, item]) =>
    methods.filter((m) => (item as Json)[m]).map((method) => ({ method, path, op: (item as Json)[method] as Json })),
  );
}

// ---------------------------------------------------------------- tests
describe('openapi.yaml is a valid OpenAPI 3.1 document', () => {
  it('passes the OpenAPI validator (structure + every $ref resolves)', async () => {
    await expect(SwaggerParser.validate(structuredClone(spec) as never)).resolves.toBeTruthy();
  });

  it('requires the Firebase bearer token globally, with no per-operation opt-out', () => {
    expect(spec.security).toEqual([{ firebaseIdToken: [] }]);
    for (const { method, path, op } of specOperations()) {
      expect(op.security, `${method.toUpperCase()} ${path} overrides security`).toBeUndefined();
    }
  });
});

describe('openapi.yaml <-> API_CONTRACTS.md 4.2', () => {
  const doc = contractEndpoints();
  const ops = specOperations();

  it('the contract lists 25 endpoints (sanity check on the doc parser)', () => {
    expect(doc).toHaveLength(25);
  });

  it('has exactly the contract endpoints, no more and no fewer', () => {
    const key = (e: { method: string; path: string }) => `${e.method.toUpperCase()} ${e.path}`;
    expect(ops.map(key).sort()).toEqual(doc.map(key).sort());
  });

  it("declares exactly each endpoint's success and error codes", () => {
    for (const e of doc) {
      const op = (spec.paths[e.path] as Json)[e.method] as Json;
      expect(Object.keys(op.responses).sort(), `${e.method.toUpperCase()} ${e.path}`).toEqual(e.codes);
    }
  });

  it('every error response uses the ApiError envelope', () => {
    for (const { method, path, op } of ops) {
      for (const [code, res] of Object.entries(op.responses as Json)) {
        if (Number(code) < 400) continue;
        const resolved = (res as Json).$ref ? resolve(spec, (res as Json).$ref) : (res as Json);
        expect(resolved.content['application/json'].schema, `${method} ${path} ${code}`).toEqual({
          $ref: '#/components/schemas/ApiError',
        });
      }
    }
  });

  it('operationIds are unique', () => {
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('openapi.yaml <-> packages/config/api-routes.json', () => {
  it("tags each operation with the service Hosting routes its path to", () => {
    const owner = (path: string) =>
      Object.entries(routes.services).find(([, s]) => s.prefixes.some((p) => `/api/v1${path}` === p || `/api/v1${path}`.startsWith(`${p}/`)))?.[0];
    for (const { method, path, op } of specOperations()) {
      const service = owner(path);
      expect(service, `${path} is not routed by api-routes.json`).toBeDefined();
      expect(op.tags, `${method.toUpperCase()} ${path}`).toEqual([service]);
    }
  });
});

describe('openapi.yaml components <-> packages/shared-types', () => {
  let ts: Json;
  beforeAll(() => {
    ts = createGenerator({
      path: file('./openapi-types.ts'),
      tsconfig: file('../tsconfig.json'),
      type: '*',
      expose: 'export',
      jsDoc: 'none',
      skipTypeCheck: true,
      additionalProperties: false,
    }).createSchema('*') as Json;
  }, 60_000);

  // Spec-only helpers: AqiRange is §4.1's inline `{ aqiMin, aqiMax }`;
  // SubmissionEnvelope is the `{ submission }` response wrapper from §4.2.
  const SPEC_ONLY = new Set(['AqiRange', 'SubmissionEnvelope']);

  it('every shared type has a component schema, and vice versa', () => {
    const tsNames = Object.keys(ts.definitions).filter((n) => !n.startsWith('Paginated<'));
    const specNames = Object.keys(spec.components.schemas).filter((n) => !SPEC_ONLY.has(n));
    // Paginated<T> itself is generic; the spec carries its instantiations.
    expect(specNames.sort()).toEqual(tsNames.filter((n) => n !== 'Paginated').sort());
  });

  it('each component schema has the same shape as its TypeScript type', () => {
    const mismatches: string[] = [];
    for (const name of Object.keys(spec.components.schemas)) {
      if (SPEC_ONLY.has(name)) continue;
      const fromTs = canon({ $ref: `#/definitions/${encodeURIComponent(name)}` }, ts);
      const fromSpec = canon({ $ref: `#/components/schemas/${name}` }, spec);
      for (const d of diff(fromSpec, fromTs)) mismatches.push(`${name}.${d}`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('the canonical comparison actually catches drift (self-test)', () => {
    const drifted = structuredClone(spec);
    delete drifted.components.schemas.User.properties.fcmTokens;
    expect(canon({ $ref: '#/components/schemas/User' }, drifted)).not.toEqual(canon({ $ref: '#/definitions/User' }, ts));
    drifted.components.schemas.AlertStatus.enum.push('archived');
    expect(canon({ $ref: '#/components/schemas/AlertStatus' }, drifted)).not.toEqual(
      canon({ $ref: '#/definitions/AlertStatus' }, ts),
    );
  });
});
