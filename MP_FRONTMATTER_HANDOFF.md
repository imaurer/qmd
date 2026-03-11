# MP Frontmatter Filtering Handoff

Date: 2026-03-11

## Summary

This note documents the current frontmatter and metadata-filtering implementation in QMD, the state of the real `/opt/mp` test index, the recommended metadata schemas by collection type, and the operating runbook for the team that will own it going forward.

The short version:

- metadata filtering is implemented and working for the exported Jira, Zendesk, and Confluence corpora
- the implementation also supports true YAML frontmatter for Markdown files
- the current real-data index was built from `/opt/mp/...` into a temporary SQLite database
- a full embedding run is in progress on that database as of this note
- the code and clinical repositories do not currently contain in-file frontmatter worth typing yet

## What Has Been Built

The current branch adds the following behavior:

- QMD extracts document metadata during indexing
- Markdown YAML frontmatter is parsed when present
- exported heading metadata blocks are parsed for the exported corpora format:
  - H1 title
  - blank line
  - bullet metadata block like `- Status: Done`
  - blank line
  - body
- raw document content is stored separately from searchable content
- the searchable body strips metadata/frontmatter so search and embeddings do not rank on that metadata text
- retrieval still returns the original raw document text
- metadata is stored on the `documents` row
- `qmd search` supports repeatable `--filter`
- `qmd search` and `qmd query` support `--where`
- SDK `search()` supports `filters` and `where`
- MCP `/query` and HTTP `/query` and `/search` accept `filters` and `where`
- JSON search results include the metadata object

Important semantics already implemented:

- repeated simple filters are `AND`
- repeated equality filters on the same field collapse to `OR`
- matching is case-insensitive for field names and string comparisons
- array fields such as `labels` and `tags` support containment matching
- date/time comparisons work for the exported ISO-like timestamp formats in the corpora

## Real Data Status

The real validation index is currently:

- path: `/tmp/qmd-mp-frontmatter.sqlite`
- source corpora:
  - `/opt/mp/jira/markdown`
  - `/opt/mp/zendesk/markdown`
  - `/opt/mp/confluence/markdown`
- indexed documents: `16,991`

This database is temporary. `/tmp` is not the correct long-term home for an operational index.

There is also a temporary benchmark copy:

- path: `/tmp/qmd-mp-embed-bench.sqlite`
- purpose: timed embedding benchmark only

## Embedding Status

As of this note, a full embedding run is in progress against:

- `/tmp/qmd-mp-frontmatter.sqlite`

Observed real benchmark on this machine:

- sample: `200` documents
- chunks: `444`
- wall-clock time: about `74s`

Observed live full-run progress after warmup:

- throughput stabilized around `10 KB/s`
- ETA settled to roughly `55 to 70 minutes` remaining at the time of writing

Practical expectation on this machine for the full refreshed index:

- roughly `70 to 90 minutes` total wall clock

## What Metadata Actually Exists Today

### Jira export

The Jira export does not use YAML frontmatter.

It does contain a consistent metadata block at the top of each document. Current extracted fields include:

- `source`
- `key`
- `project`
- `type`
- `status`
- `priority`
- `assignee`
- `reporter`
- `created`
- `updated`
- `parent`
- `labels`

### Zendesk export

The Zendesk export also does not use YAML frontmatter.

It contains the same top-of-document bullet metadata pattern. Current extracted fields include:

- `source`
- `ticket_id`
- `status`
- `priority`
- `type`
- `created`
- `updated`
- `organization_id`
- `requester_id`
- `assignee_id`
- `tags`

### Confluence export

The Confluence export also does not use YAML frontmatter.

It contains a top-of-document metadata block. Current extracted fields include:

- `source`
- `page_id`
- `space`
- `version`
- `updated`
- `created_by`
- `labels`
- `url`

### Clinical repository docs

The Markdown docs under `/opt/mp/clinical` do not currently show YAML frontmatter.

Examples inspected include:

- repository root `README.md`
- `documentation/*.md`
- `api-schemas/README.md`
- multiple script and deployment READMEs

These are normal Markdown documents with headings and prose, not metadata-bearing Markdown files.

### Knowledge repository docs

The Markdown docs under `/opt/mp/knowledge` also do not currently show YAML frontmatter.

Examples inspected include:

- repository READMEs
- deploy READMEs
- API and workflow READMEs
- engine and app documentation

These are also ordinary Markdown docs without consistent in-file metadata blocks.

## Recommended Schemas

### 1. Exported Jira schema

This should be treated as a typed collection schema even if storage stays schema-less in SQLite for v1.

Recommended field definitions:

- `source`: string, fixed value `jira`
- `key`: string
- `project`: string
- `type`: string
- `status`: string
- `priority`: string
- `assignee`: string
- `reporter`: string
- `parent`: string or null
- `labels`: string array
- `created`: datetime
- `updated`: datetime

Recommended common filters:

- `project`
- `status`
- `assignee`
- `priority`
- `updated`
- `labels`

### 2. Exported Zendesk schema

Recommended field definitions:

- `source`: string, fixed value `zendesk`
- `ticket_id`: string
- `status`: string
- `priority`: string
- `type`: string
- `organization_id`: string
- `requester_id`: string
- `assignee_id`: string
- `tags`: string array
- `created`: datetime
- `updated`: datetime

Recommended common filters:

- `type`
- `status`
- `priority`
- `updated`
- `tags`
- `organization_id`

Likely future enrichment:

- organization name
- human assignee name
- product/client aliases

### 3. Exported Confluence schema

Recommended field definitions:

- `source`: string, fixed value `confluence`
- `page_id`: string
- `space`: string
- `version`: integer
- `updated`: datetime
- `created_by`: string
- `labels`: string array
- `url`: string

Recommended common filters:

- `space`
- `updated`
- `created_by`
- `labels`

### 4. Clinical repository docs schema

There is no current in-file metadata schema to type.

Recommendation:

- do not invent a typed content schema yet
- keep these searchable as ordinary Markdown docs
- if typed filtering is desired later, add real YAML frontmatter to selected docs

If the team wants to adopt frontmatter for repository docs later, a reasonable schema would be:

- `source`: string, fixed value like `clinical-docs`
- `repo`: string, fixed value `clinical`
- `doc_type`: enum-like string such as `readme`, `runbook`, `design`, `deployment`, `testing`, `reference`
- `component`: string
- `owner_team`: string
- `audience`: string array
- `status`: string such as `active`, `draft`, `deprecated`
- `tags`: string array
- `last_reviewed`: date

### 5. Knowledge repository docs schema

The same recommendation applies.

There is no observed in-file frontmatter to type today.

If the team adopts frontmatter later, a reasonable schema would be:

- `source`: string, fixed value like `knowledge-docs`
- `repo`: string, fixed value `knowledge`
- `doc_type`: string
- `component`: string
- `owner_team`: string
- `audience`: string array
- `status`: string
- `tags`: string array
- `last_reviewed`: date

### 6. Path-derived schema for repo docs

If the team wants filters on the repository docs before adding frontmatter, the most realistic next step is path-derived metadata, not content parsing.

Examples:

- `repo=clinical|knowledge`
- `top_dir=documentation|apps|engine|deploy|scripts|api-schemas|...`
- `filename=README|DEPLOYMENT|TESTING|...`
- `doc_type` derived from filename and path

That is a separate follow-up from the current frontmatter work.

## Recommendation on Typed Schemas

Recommended policy:

- keep storage schema-less in SQLite for now
- define typed schemas in documentation for the exported collections
- only add typed validation after the owning team confirms field names and allowed values

This gives the team:

- stable filter contracts for Jira, Zendesk, and Confluence
- no forced fake schema for the code repositories
- room to add explicit frontmatter to curated docs later

## Runbook

### Option A: Preserve the current working real-data index

If the team wants to keep the exact index already built and validated, copy it out of `/tmp` after the current embed finishes:

```bash
mkdir -p ~/.cache/qmd
cp /tmp/qmd-mp-frontmatter.sqlite ~/.cache/qmd/mp.sqlite
```

Then use it with a named index:

```bash
qmd --index mp status
qmd --index mp search "variant history" --filter source=jira --filter "assignee=Matthew Stachowiak"
qmd --index mp query "UCSF" --where "source='jira' AND assignee='James Cole'"
```

This is the lowest-effort handoff path.

### Option B: Rebuild a clean durable index through the CLI

If the team wants a clean managed setup under a named index:

```bash
qmd --index mp collection add /opt/mp/jira/markdown --name jira --mask '**/*.md'
qmd --index mp collection add /opt/mp/zendesk/markdown --name zendesk --mask '**/*.md'
qmd --index mp collection add /opt/mp/confluence/markdown --name confluence --mask '**/*.md'
qmd --index mp collection add /opt/mp/clinical --name clinical-docs --mask '**/*.md'
qmd --index mp collection add /opt/mp/knowledge --name knowledge-docs --mask '**/*.md'
qmd --index mp update
qmd --index mp embed
```

This creates the durable DB at:

- `~/.cache/qmd/mp.sqlite`

And the matching config file at:

- `~/.config/qmd/mp.yml`

### Recommended near-term operating model

For the exported sources:

- keep `jira`, `zendesk`, and `confluence` as separate collections
- use metadata filters heavily there

For the repositories:

- index them as `clinical-docs` and `knowledge-docs`
- use collection scoping first
- only add typed metadata later if those teams adopt frontmatter or path-derived metadata

## Example Queries

Jira:

```bash
qmd --index mp search "variant history" --filter source=jira --filter "assignee=Matthew Stachowiak" --json
```

Jira with advanced expression:

```bash
qmd --index mp search "UCSF" --where "source='jira' AND assignee='James Cole' AND updated >= '2022-01-01T00:00:00.000Z'" --json
```

Zendesk:

```bash
qmd --index mp search "incident" --filter source=zendesk --filter type=incident --json
```

Confluence:

```bash
qmd --index mp search "metrics" --filter source=confluence --filter space=BO --json
```

Raw retrieval still returns the original exported metadata block:

```bash
qmd --index mp get qmd://jira/som-7332-mdf-1-amp-tiers-history-has-disappeared-2-cannot-delete-amp-tier-override.md -l 12
```

## Remaining Work

### Functionally complete enough for the intended v1 workflow

Once the current embedding run completes, the main intended workflow is in place.

### Not yet implemented

- `qmd vsearch` does not yet support metadata filters
- human CLI output does not yet have a richer metadata-display mode
- no dedicated metadata indexes exist for hot fields
- no typed schema enforcement exists yet
- no nested metadata paths exist
- no alias normalization exists yet
- no Org-mode metadata extraction exists yet
- indexing logic between store and CLI could still be consolidated further

## Suggested Ownership Steps

Recommended next actions for the MP team:

1. Let the current full embedding run complete.
2. Move the validated DB from `/tmp/qmd-mp-frontmatter.sqlite` to a durable location or rebuild it under `--index mp`.
3. Decide whether the team wants:
   - DB-only operation using stored collection metadata
   - or named-index YAML-managed operation using `~/.config/qmd/mp.yml`
4. Treat the exported schemas above as the initial typed contract.
5. Defer typed schemas for `clinical` and `knowledge` until those repos adopt real frontmatter or path-derived metadata.
6. If performance becomes an issue, add dedicated indexes for the hot fields instead of changing query syntax.

## Bottom Line

The exported support corpora now behave like metadata-filterable documents inside QMD, even though they are not written with YAML frontmatter. That is the right shape for the current data.

The repository docs do not currently justify a typed content schema because they do not contain structured in-file metadata. Those should stay as ordinary docs for now unless the owning teams decide to add frontmatter intentionally.
