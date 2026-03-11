# Frontmatter Metadata Filtering Design

Status: Draft living document

Baseline: This design reflects the QMD repository structure as of March 11, 2026.

## Summary

QMD should support extracting YAML frontmatter from Markdown documents, storing it as structured metadata, and allowing callers to filter search results by that metadata.

The feature is intended to improve retrieval precision before lexical or semantic ranking happens. It should work across CLI usage, SDK consumers, and MCP/HTTP clients without requiring callers to know internal database details.

This document describes the intended functionality, the required architecture, and the file-by-file implementation plan for the current QMD codebase.

## Goals

- Extract YAML frontmatter from Markdown documents during indexing.
- Preserve the original file content for retrieval.
- Remove frontmatter from the searchable body used by FTS, vector embedding, snippet extraction, and reranking.
- Store full extracted frontmatter as JSON metadata on each document.
- Support metadata filtering in:
  - `qmd search`
  - `qmd query`
  - SDK `search()`
  - MCP `query`
  - HTTP `POST /query` and `POST /search`
- Support a simple repeatable filter syntax and an advanced expression syntax.
- Return full metadata in JSON-oriented result surfaces.
- Keep v1 schema-less at the collection level.

## Non-Goals

- Org-mode metadata extraction in v1.
- Automatic semantic alias expansion in the filter layer.
- Dedicated metadata indexes in v1.
- Metadata filtering for `vsearch` in v1.
- Exact array equality, nested JSON path querying, or arbitrary SQL exposure.
- A full typed schema system in v1.

## User-Facing Behavior

### Markdown frontmatter handling

QMD should treat a document as frontmatter-bearing only when it starts with a valid YAML frontmatter block:

```md
---
status: In Test
assignee: Jane Doe
tags:
  - release
  - customer-x
updated: 2026-01-15T13:25:00Z
---

# Heading
Body text...
```

Behavior:

- The full original file remains retrievable.
- The searchable body excludes the frontmatter block.
- Title extraction should prefer `frontmatter.title` when present.
- Metadata changes count as document changes.
- Invalid YAML should fail open:
  - the file is indexed
  - metadata is stored as `null`
  - the full content remains searchable if parsing fails before frontmatter removal is possible

### CLI filtering

QMD should add two filtering paths:

- `--filter` for simple repeated atomic clauses
- `--where` for advanced boolean expressions

`--filter` supports:

- `field=value`
- `field!=value`
- `field>=value`
- `field<=value`
- `field~value`

Semantics:

- Repeated `--filter` flags combine with `AND`.
- Repeated equality filters on the same scalar field combine with `OR`.
- Array fields match by containment.
- String matching is case-insensitive.
- Field names are case-insensitive.
- Missing fields do not match positive filters.

Examples:

```bash
qmd search "incident" \
  --filter "source=jira" \
  --filter "status=In Test" \
  --filter "status=In Code" \
  --filter "updated>=2026-01-01"
```

```bash
qmd query "release risk" \
  --where "source = 'jira' AND project = 'OPS' AND updated >= '2026-01-01'"
```

### SDK and MCP filtering

The SDK and MCP interfaces should expose both:

- `filters: string[]`
- `where?: string`

These represent different caller intents:

- `filters` for structured, low-friction filtering
- `where` for explicit boolean logic

### Search result metadata

- CLI JSON output should include the full metadata object.
- MCP structured results should include the full metadata object.
- Human-oriented CLI output can stay compact by default.
- Retrieval commands should continue to return original document content by default, including frontmatter.

## Current Codebase Baseline

As of March 11, 2026, the relevant architecture is:

- `src/store.ts`
  - owns database schema creation
  - owns indexing helpers and the pure `reindexCollection()` path
  - owns FTS, vector search, hybrid search, structured search, retrieval, and result types
- `src/cli/qmd.ts`
  - duplicates collection reindex logic locally for the CLI update path
  - defines search/query CLI flags and output plumbing
- `src/index.ts`
  - exposes the SDK surface
- `src/mcp/server.ts`
  - exposes MCP and HTTP query surfaces
- `src/cli/formatter.ts`
  - owns JSON/CSV/Markdown/XML output formatting
- `src/collections.ts`
  - owns YAML collection config typing and persistence
- `test/*.test.ts`
  - already cover store, SDK, CLI, MCP, and multi-collection behavior

Important current constraints:

- There is no explicit migration framework or `PRAGMA user_version` versioning.
- The `documents` table currently stores only file-level metadata and the raw content hash.
- The `content` table currently stores a single `doc` body that is used both for retrieval and for search.
- FTS and vector search currently both read from the same stored body.
- `qmd get` currently reads document bodies from the database, not from the filesystem.

Those constraints matter because the desired behavior is:

- retrieve the original file
- search only the body without frontmatter

That requires a storage split in v1, not just a new metadata column.

## Proposed Architecture

## 1. Storage model

### Recommended schema changes

Add document metadata and a separate indexed body representation.

#### `documents`

Add:

- `metadata TEXT NULL`

Purpose:

- store the extracted YAML frontmatter as JSON text
- keep metadata attached to the document row, since filters apply at the document level

#### `content`

Add:

- `search_doc TEXT NOT NULL`

Purpose:

- keep `doc` as the raw original file for retrieval
- keep `search_doc` as the frontmatter-stripped body for search, embeddings, snippets, and reranking

This is the key design choice for v1.

Without `search_doc`, QMD would have to choose between:

- storing raw content and polluting search with frontmatter
- storing stripped content and breaking faithful retrieval

The current architecture requires both bodies to exist.

### Why store `metadata` on `documents` and `search_doc` on `content`

`metadata` belongs on `documents` because:

- filters are document-scoped
- different files can point to different document rows even if content deduplicates
- title override behavior is document-level

`search_doc` belongs on `content` because:

- the stripped body is derived from the full raw content
- the raw-content hash already keys content storage
- FTS and vector embedding already consume content-addressed bodies

### Tradeoff accepted in v1

If only frontmatter changes:

- the raw content hash changes
- a new `content` row is created
- embeddings may be recomputed even if `search_doc` is identical

That is acceptable for v1 because correctness is more important than deduplicating equal stripped bodies.

## 2. Frontmatter parsing

Add a parsing helper in `src/store.ts`:

- detect YAML frontmatter only at the start of Markdown files
- parse YAML using the existing `yaml` package already present in the repo
- return:
  - `rawBody`
  - `searchBody`
  - `metadata`
  - `titleOverride` when `metadata.title` is a non-empty string

Suggested return shape:

```ts
type ParsedMarkdownFrontmatter = {
  rawBody: string;
  searchBody: string;
  metadata: Record<string, unknown> | null;
  titleOverride: string | null;
};
```

Rules:

- Only parse `.md` files in v1.
- For non-Markdown files:
  - `searchBody = rawBody`
  - `metadata = null`
- If YAML parsing fails:
  - preserve `rawBody`
  - set `searchBody = rawBody`
  - set `metadata = null`

## 3. Title selection

Title selection order in v1:

1. `frontmatter.title` if present and non-empty
2. existing heading-based title extraction
3. filename fallback

This should be implemented centrally in store logic so CLI, SDK, and tests all share the same behavior.

## 4. Indexing pipeline

Indexing should change from:

- hash raw content
- store raw content
- derive title from raw content

to:

- read raw content from disk
- parse frontmatter
- hash raw content
- store:
  - `content.doc = raw content`
  - `content.search_doc = stripped search body`
- derive title from `frontmatter.title` or stripped body
- store `documents.metadata`

### Why hashing should remain based on raw content

This preserves the requirement that metadata-only changes count as document changes.

## 5. Search pipeline

All search and reranking operations should use `search_doc`, not raw `doc`.

This affects:

- FTS trigger population
- FTS query joins
- vector search body loading
- embedding source bodies
- snippet extraction inputs
- hybrid search candidate bodies
- structured search candidate bodies

Retrieval should continue to use raw `doc`.

## 6. Metadata filtering engine

QMD should add an internal metadata filter layer that compiles caller input into SQL fragments and parameters against `documents.metadata`.

### Filter forms

#### Simple filters

Input:

- `filters: string[]`
- CLI `--filter` repeated

Supported operators:

- `=`
- `!=`
- `>=`
- `<=`
- `~`

#### Advanced expressions

Input:

- `where?: string`
- CLI `--where`

This should support:

- `AND`
- `OR`
- parentheses
- `IN (...)`
- `IS MISSING`
- `= null`

### Internal design recommendation

Implement a small internal AST instead of string-splicing SQL everywhere.

Suggested layers:

1. `parseSimpleFilter(filter: string): FilterClause`
2. `groupSimpleFilters(filters: FilterClause[]): FilterExpr`
3. `parseWhereExpression(where: string): FilterExpr`
4. `compileFilterExprToSql(expr: FilterExpr): { sql: string; params: unknown[] }`

Suggested internal nodes:

```ts
type FilterExpr =
  | { type: "and"; items: FilterExpr[] }
  | { type: "or"; items: FilterExpr[] }
  | { type: "cmp"; field: string; op: "=" | "!=" | ">=" | "<=" | "~"; value: string | number | boolean | null }
  | { type: "in"; field: string; values: Array<string | number | boolean | null> }
  | { type: "missing"; field: string; negated?: boolean };
```

### SQL compilation strategy

Use SQLite JSON1 functions against `documents.metadata`.

Core patterns:

- scalar extraction: `json_extract(d.metadata, ?)`
- existence check: `json_type(d.metadata, ?) IS NOT NULL`
- array containment: `EXISTS (SELECT 1 FROM json_each(d.metadata, ?) WHERE ...)`

Field paths in v1 should be flat top-level keys only:

- `status`
- `assignee`
- `updated`
- `tags`

That keeps parsing and SQL generation narrow.

### Type handling in v1

V1 is schema-less, so type handling should be conservative:

- equality and inequality operate on scalar stringified values for string fields
- booleans should recognize `true` and `false`
- `null` should map to SQL `NULL`-style checks on JSON values
- `>=` and `<=` should work for:
  - numbers when the JSON value is numeric
  - timestamps and dates after normalization to a comparable representation

## 7. Timestamp normalization

V1 needs reliable comparison for:

- UTC timestamps ending in `Z`
- timestamps with timezone offsets like `-0400`
- plain dates supplied by the user

### Recommended v1 decision

Normalize comparable timestamp values at index time into the visible `metadata` object.

That means:

- keep non-date metadata values unchanged
- for fields whose YAML values parse as dates or datetimes, store canonical ISO 8601 UTC strings
- compare against the canonical stored values in filter SQL

Examples:

- `2022-09-16T12:57:04.608-0400` becomes `2022-09-16T16:57:04.608Z`
- `2017-07-05T17:59:48Z` stays UTC
- a query value like `2026-01-01` is interpreted as a date boundary value for comparison

Why this is the recommended v1 path:

- it avoids depending on SQLite to parse every source timestamp variant consistently
- it keeps comparison logic simple and testable
- it avoids introducing a second metadata column in v1

Tradeoff:

- output metadata for normalized date fields will use canonical UTC strings rather than the original exporter formatting

That tradeoff is acceptable in v1 because filter correctness matters more than preserving source timestamp formatting byte-for-byte.

## 8. Collection configuration

`src/collections.ts` should support optional frontmatter configuration, but v1 should not require it.

Suggested config shape:

```ts
export interface Collection {
  path: string;
  pattern: string;
  ignore?: string[];
  context?: ContextMap;
  update?: string;
  includeByDefault?: boolean;
  frontmatter?: {
    extract?: boolean;
  };
}
```

V1 behavior:

- default Markdown behavior can be global-on
- `frontmatter.extract: false` can disable parsing for a collection if needed

If the team prefers minimum configuration churn, this can be deferred entirely and v1 can simply parse frontmatter for all Markdown documents.

Recommended v1 choice:

- parse Markdown frontmatter by default
- add config support only if it is low-cost once the core feature is done

## 9. Output behavior

### Search results

Add `metadata?: Record<string, unknown> | null` to search result types returned by:

- store search helpers
- hybrid results
- SDK results
- MCP structured content
- CLI JSON output

Human-readable CLI output should not print full metadata by default.

Optional v1.1 enhancement:

- `--show-metadata key1,key2,key3`

That is useful but not required for the core filtering feature.

### Retrieval

`get` and `multi_get` should continue to return original content by default.

That means:

- `findDocument(..., { includeBody: true })` should read `content.doc`
- `getDocumentBody()` should read `content.doc`

## Migration Strategy

QMD currently has no schema migration framework, so v1 should use idempotent schema reconciliation inside `src/store.ts`.

Recommended startup behavior:

1. Create tables if absent.
2. Inspect `PRAGMA table_info(documents)` and `PRAGMA table_info(content)`.
3. If `documents.metadata` is missing, run:

```sql
ALTER TABLE documents ADD COLUMN metadata TEXT;
```

4. If `content.search_doc` is missing, run:

```sql
ALTER TABLE content ADD COLUMN search_doc TEXT;
```

5. Backfill `content.search_doc = content.doc` for existing rows where `search_doc IS NULL`.
6. Recreate or update FTS triggers so they index `content.search_doc` instead of `content.doc`.
7. Rebuild FTS from current rows after trigger changes.

### Re-embedding

Existing embeddings were built from raw content. After this change, embeddings should come from `search_doc`.

Recommended behavior:

- do not silently trust old embeddings after rollout
- document that a full `qmd embed --force` is recommended after upgrading

If the implementation can cheaply invalidate old embeddings, that is better, but it is not required for the design to succeed.

## Detailed File-by-File Changes

## `src/store.ts`

This file carries most of the implementation.

### Schema and initialization

- add schema reconciliation for:
  - `documents.metadata`
  - `content.search_doc`
- update FTS triggers to index `content.search_doc`
- add an FTS rebuild path for migrated databases

### Types

- extend `DocumentResult` with:
  - `metadata?: Record<string, unknown> | null`
- extend `SearchResult` implicitly through `DocumentResult`
- extend `HybridQueryResult` with:
  - `metadata?: Record<string, unknown> | null`
- extend any DB row helper types used by document lookup and search joins

### Parsing helpers

- add frontmatter parsing helpers for Markdown
- add title override support
- add filter parser and filter compiler helpers
- add metadata normalization helpers as needed for v1 date comparison

### Indexing helpers

- change `insertContent()` to accept both raw doc and search doc
- change `insertDocument()` to accept metadata
- change `findActiveDocument()` to return metadata as needed for change comparison
- change `updateDocumentTitle()` and `updateDocument()` to update metadata when required
- update `reindexCollection()` to:
  - parse frontmatter
  - store raw content and stripped search body separately
  - compute titles correctly
  - persist metadata

### Search and retrieval

- update `searchFTS()` to join/select `content.search_doc`
- update `searchVec()` to join/select `content.search_doc`
- update `getHashesForEmbedding()` to read `content.search_doc`
- update `findDocument()` to select `documents.metadata`
- keep `getDocumentBody()` and retrieval paths on `content.doc`
- update `findDocuments()` to include metadata if bodies/results expose it
- thread filter SQL into:
  - `searchFTS()`
  - `hybridQuery()`
  - `structuredSearch()`

### Store interface

Extend the internal `Store` interface so consumers can pass filters/where without needing local SQL knowledge.

## `src/cli/qmd.ts`

### Indexing path

This file currently duplicates indexing logic instead of delegating entirely to `reindexCollection()`.

Changes needed:

- apply the same frontmatter parsing and dual-body storage logic to the CLI reindex path around the current file processing loop
- or, preferably, remove duplication by routing CLI indexing through the pure store helper

Recommended choice:

- keep behavior aligned by reducing duplication where practical

### CLI argument parsing

Add options:

- `--filter <expr>` with `multiple: true`
- `--where <expr>`

Extend `OutputOptions` or a separate query-options type to include:

- `filters?: string[]`
- `where?: string`

### Search command wiring

- thread filters into `search()`
- thread filters into `querySearch()`
- leave `vectorSearch()` unchanged for v1
- update `--help` output with filter syntax and examples

### Empty-result behavior

No special change required beyond normal filtering.

However, CLI help text should make it explicit that metadata filters can exclude entire collections when fields are missing.

## `src/index.ts`

Extend SDK types:

- `SearchOptions`
  - `filters?: string[]`
  - `where?: string`
- `LexSearchOptions`
  - optionally add `filters?: string[]`
  - `where?: string` only if `searchLex()` is included in scope later

Recommended v1 scope:

- only `search()` gets filter support
- `searchLex()` and `searchVector()` stay unchanged unless implementation cost is negligible

Update the `search()` wrapper to pass filter options through to:

- `structuredSearch()` when `queries` are provided
- `hybridQuery()` when `query` is provided

Update exported result typing so metadata is visible to SDK callers.

## `src/mcp/server.ts`

Add tool and HTTP input fields:

- `filters?: string[]`
- `where?: string`

Apply them in:

- MCP `query` tool
- HTTP `POST /query`
- HTTP `POST /search`

Update:

- Zod schemas
- handler mapping into `store.search()`
- structured result payload to include `metadata`
- server instructions/examples so agents know filters exist

Recommended MCP structured result addition:

```ts
type SearchResultItem = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
  metadata: Record<string, unknown> | null;
};
```

## `src/cli/formatter.ts`

Update JSON output:

- include `metadata` on each result when present

Leave:

- CSV
- Markdown
- XML
- files

unchanged in v1 unless the team wants a compact metadata display flag.

## `src/collections.ts`

Optional v1 change:

- add `frontmatter?: { extract?: boolean }` to the `Collection` type
- persist it through YAML load/save
- sync it into store collection config if needed

This is useful but not strictly required for the core filtering feature.

## `test/store.test.ts`

Add coverage for:

- frontmatter parsing success
- invalid YAML fallback behavior
- title override from frontmatter
- raw retrieval vs stripped search body
- metadata persistence on insert/update
- metadata-only file changes counting as updates
- FTS using stripped body
- embeddings sourcing stripped body
- simple filter parsing
- repeated equality collapsing to same-field `OR`
- mixed-field filters using `AND`
- array containment
- case-insensitive matching
- missing-field behavior
- date comparisons for:
  - `Z`
  - offset timestamps
  - plain ISO dates

## `test/sdk.test.ts`

Add coverage for:

- `search({ filters })`
- `search({ where })`
- metadata presence in returned results
- retrieval still returning original content with frontmatter

## `test/mcp.test.ts`

Add coverage for:

- MCP `query` accepting `filters`
- MCP `query` accepting `where`
- HTTP `/query` and `/search` accepting filters
- metadata presence in structured content

## `test/cli.test.ts`

Add coverage for:

- CLI `search --filter`
- CLI `query --filter`
- CLI `query --where`
- CLI `--json` output containing metadata
- help text documenting the new options

## `test/formatter.test.ts`

Add coverage for:

- JSON formatter emitting metadata

## `test/multi-collection-filter.test.ts`

Add coverage for:

- multi-collection filtering with missing fields excluded by default

This file already exists and is the natural place for cross-collection filter behavior.

## Query Compilation Design

### Recommended v1 scope

Keep the grammar intentionally narrow.

#### `--filter`

Grammar:

```txt
<field><op><value>
```

Where:

- `<field>` is `[A-Za-z0-9_-]+`
- `<op>` is one of `=`, `!=`, `>=`, `<=`, `~`
- `<value>` is the remainder of the string, trimmed

No quoting rules are needed in `--filter` beyond shell quoting handled by the caller.

#### `--where`

Recommended tokens:

- identifiers
- string literals in single quotes
- numbers
- `true`
- `false`
- `null`
- `AND`
- `OR`
- `IN`
- `IS MISSING`
- `(`
- `)`
- comparison operators

This should be parsed by a small dedicated parser, not split heuristically.

### Same-field equality grouping

Rule:

- repeated simple equality filters on the same field compile to `OR`
- all other simple filters remain in the top-level `AND`

Example:

```bash
--filter "status=In Test" \
--filter "status=In Code" \
--filter "assignee=Jane Doe"
```

Compiles logically to:

```txt
(status = 'In Test' OR status = 'In Code') AND assignee = 'Jane Doe'
```

### Array containment

For `=` and `!=` on arrays:

- `=` means contains
- `!=` means does not contain

For `~` on arrays:

- match any element by case-insensitive substring

## Recommended Implementation Sequence

1. Add schema reconciliation for `documents.metadata` and `content.search_doc`.
2. Add frontmatter parsing and title override helpers.
3. Update indexing paths in `src/store.ts` and `src/cli/qmd.ts`.
4. Update FTS/vector/retrieval code to respect raw-vs-search body split.
5. Add internal filter AST, simple parser, and SQL compiler.
6. Thread filtering into store search functions.
7. Expose filtering through CLI.
8. Expose filtering through SDK.
9. Expose filtering through MCP and HTTP.
10. Update JSON output and structured result payloads.
11. Add tests.
12. Document post-upgrade re-embedding guidance.

## Risks and Tradeoffs

### 1. The no-migration-framework problem

Risk:

- schema changes are easy to get partially right and hard to reason about later

Mitigation:

- keep migration logic idempotent and colocated in `src/store.ts`
- add tests for opening old-style databases

### 2. Raw body vs search body complexity

Risk:

- subtle regressions where retrieval accidentally returns stripped content
- subtle regressions where search accidentally uses raw content

Mitigation:

- enforce the split in tests at the store level
- use clearly named helpers and columns

### 3. Timestamp comparison correctness

Risk:

- SQLite date handling can be inconsistent for certain offset forms

Mitigation:

- write targeted tests using the actual timestamp shapes QMD expects
- only broaden supported formats after tests pass

### 4. Query compiler correctness

Risk:

- hand-built SQL from filters can become fragile or unsafe

Mitigation:

- compile through an AST
- parameterize all values
- keep field names constrained to top-level keys in v1

### 5. Duplicate indexing logic

Risk:

- store indexing and CLI indexing drift apart

Mitigation:

- prefer consolidating around `reindexCollection()` or share a common helper

## Acceptance Criteria

The feature is complete when all of the following are true:

- QMD extracts YAML frontmatter from Markdown files during indexing.
- Search does not rank or embed frontmatter text.
- Retrieval still returns the original file content.
- Metadata is stored and survives update cycles.
- `qmd search` and `qmd query` accept `--filter` and `--where`.
- SDK `search()` accepts `filters` and `where`.
- MCP and HTTP query surfaces accept `filters` and `where`.
- JSON results include metadata.
- Missing metadata fields do not match positive filters.
- Repeated equality filters on the same field behave as `OR`.
- Exporter-style timestamps compare correctly in tests.

## Deferred Work

These items are intentionally out of scope for v1 but should be easy to layer later:

- typed per-collection metadata schemas
- dedicated SQLite indexes for hot metadata fields
- `vsearch` filter support
- compact metadata display flags in human CLI output
- nested metadata paths
- alias normalization and enrichment
- Org-mode metadata extraction

## Implementation Notes

Use this section as the living log once work starts.

- Status:
  2026-03-11: first working implementation completed in the local branch.
- Branch / PR:
- Migration notes:
  Existing indexes need `qmd update` to populate metadata and stripped search bodies.
  Running `qmd embed --force` after that is the safe follow-up because embeddings now come from stripped search content.
- Manual test notes:
  Focused automated coverage passes in `test/frontmatter-filter.test.ts` and the CLI regression coverage in `test/cli.test.ts`.
  Real-data validation passed against representative exported Jira, Zendesk, and Confluence corpora.
  Verified real CLI cases:
  `qmd search "deployment issue" --filter source=jira --filter "assignee=Example User" --json`
  `qmd search "account" --where "source='jira' AND status='To Do' AND updated >= '2022-01-01T00:00:00.000Z'" --json`
  `qmd search "incident" --filter source=zendesk --filter type=incident --json`
  `qmd search "metrics" --filter source=confluence --filter space=ENG --json`
  `qmd get qmd://jira/example-ticket.md -l 12`
  Verified that retrieval still returns raw document text including exporter metadata blocks, while search uses stripped content.
- Follow-up issues:
  `qmd query` works with filters and `where`, but vector retrieval quality still depends on generating embeddings for the refreshed index.
  `vsearch` is still out of scope for this first pass.
