import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  parseDocumentForIndexing,
  reindexCollection,
  searchFTS,
  findDocument,
  type Store,
} from "../src/store.js";

let rootDir: string;
let docsDir: string;
let store: Store;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "qmd-frontmatter-test-"));
  docsDir = join(rootDir, "docs");
  await mkdir(docsDir, { recursive: true });
  store = createStore(join(rootDir, "index.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(rootDir, { recursive: true, force: true });
});

describe("frontmatter filtering", () => {
  test("parseDocumentForIndexing strips frontmatter and prefers frontmatter title", () => {
    const parsed = parseDocumentForIndexing(
      `---\ntitle: Canonical Title\nupdated: 2026-01-15T10:00:00-0500\n---\n\n# Heading\n\nBody text\n`,
      "note.md"
    );

    expect(parsed.title).toBe("Canonical Title");
    expect(parsed.searchBody).toContain("# Heading");
    expect(parsed.searchBody).not.toContain("title: Canonical Title");
    expect(parsed.metadata).toMatchObject({
      title: "Canonical Title",
      updated: "2026-01-15T15:00:00.000Z",
    });
  });

  test("searchFTS filters on scalar, array, and date metadata", async () => {
    await writeFile(join(docsDir, "a.md"), `---\nstatus: In Test\nassignee: Alex Example\ntags:\n  - urgent\nupdated: 2026-01-15T10:00:00-0500\ntitle: Ticket Alpha\n---\n\nJMML rollout note\n`);
    await writeFile(join(docsDir, "b.md"), `---\nstatus: Done\nassignee: Blake Example\ntags:\n  - archive\nupdated: 2025-12-01T00:00:00Z\n---\n\nJMML historical note\n`);

    await reindexCollection(store, docsDir, "**/*.md", "docs");

    const results = searchFTS(store.db, "JMML", 10, "docs", {
      filters: [
        "status=In Test",
        "assignee=alex example",
        "tags=urgent",
        "updated>=2026-01-01",
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Ticket Alpha");
    expect(results[0]?.metadata).toMatchObject({
      status: "In Test",
      assignee: "Alex Example",
    });
    expect(results[0]?.body).not.toContain("status: In Test");
  });

  test("exported heading metadata blocks are indexed as metadata", async () => {
    await writeFile(join(docsDir, "jira.md"), `# SOM-428 - Cuke: BAM sniffing for region rules\n\n- Type: Story\n- Status: Done\n- Priority: Highest\n- Assignee: Casey Example\n- Created: 2015-02-02T14:22:52.229-0500\n- Updated: 2016-07-15T19:41:47.216-0400\n- Labels: Cuke, Dev\n\n## Description\n\nRegion rules note\n`);

    await reindexCollection(store, docsDir, "**/*.md", "jira");

    const results = searchFTS(store.db, "region", 10, "jira", {
      filters: ["project=SOM", "status=Done", "labels=cuke", "source=jira"],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.metadata).toMatchObject({
      key: "SOM-428",
      project: "SOM",
      status: "Done",
      source: "jira",
    });
    expect(results[0]?.body).not.toContain("- Status: Done");
  });

  test("repeated equality filters collapse to same-field OR and where works", async () => {
    await writeFile(join(docsDir, "a.md"), `---\nstatus: In Test\nproject: OPS\nupdated: 2026-01-10T00:00:00Z\n---\n\nJMML alpha\n`);
    await writeFile(join(docsDir, "b.md"), `---\nstatus: In Code\nproject: OPS\nupdated: 2026-01-20T00:00:00Z\n---\n\nJMML beta\n`);
    await writeFile(join(docsDir, "c.md"), `---\nstatus: Done\nproject: OPS\nupdated: 2025-12-20T00:00:00Z\n---\n\nJMML gamma\n`);

    await reindexCollection(store, docsDir, "**/*.md", "docs");

    const repeated = searchFTS(store.db, "JMML", 10, "docs", {
      filters: ["status=In Test", "status=In Code"],
    });
    expect(repeated).toHaveLength(2);

    const advanced = searchFTS(store.db, "JMML", 10, "docs", {
      where: "project = 'OPS' AND updated >= '2026-01-15T00:00:00.000Z'",
    });
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.displayPath).toBe("docs/b.md");
  });

  test("findDocument returns original raw body including frontmatter", async () => {
    await writeFile(join(docsDir, "a.md"), `---\ntitle: Ticket Alpha\nstatus: In Test\n---\n\n# Wrong Heading\n\nJMML rollout note\n`);
    await reindexCollection(store, docsDir, "**/*.md", "docs");

    const doc = findDocument(store.db, "qmd://docs/a.md", { includeBody: true });
    if ("error" in doc) {
      throw new Error("document not found");
    }

    expect(doc.title).toBe("Ticket Alpha");
    expect(doc.metadata).toMatchObject({ status: "In Test" });
    expect(doc.body).toContain("status: In Test");
    expect(doc.body).toContain("# Wrong Heading");
  });
});
