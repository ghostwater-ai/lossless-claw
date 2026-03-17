import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runLcmMigrations summary depth backfill", () => {
  it("adds depth and metadata from summary lineage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );

      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );

      CREATE TABLE summary_parents (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
    `);

    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)`).run(
      1,
      "legacy-session",
    );

    const insertSummaryStmt = db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    );
    insertSummaryStmt.run("sum_leaf_a", 1, "leaf", "leaf-a", 10);
    insertSummaryStmt.run("sum_leaf_b", 1, "leaf", "leaf-b", 10);
    insertSummaryStmt.run("sum_condensed_1", 1, "condensed", "condensed-1", 10);
    insertSummaryStmt.run("sum_condensed_2", 1, "condensed", "condensed-2", 10);
    insertSummaryStmt.run("sum_condensed_orphan", 1, "condensed", "condensed-orphan", 10);

    const insertMessageStmt = db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMessageStmt.run(1, 1, 1, "user", "m1", 5, "2026-01-01 10:00:00");
    insertMessageStmt.run(2, 1, 2, "assistant", "m2", 5, "2026-01-01 11:30:00");
    insertMessageStmt.run(3, 1, 3, "user", "m3", 5, "2026-01-01 12:45:00");

    const linkMessageStmt = db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkMessageStmt.run("sum_leaf_a", 1, 0);
    linkMessageStmt.run("sum_leaf_a", 2, 1);
    linkMessageStmt.run("sum_leaf_b", 3, 0);

    const linkStmt = db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkStmt.run("sum_condensed_1", "sum_leaf_a", 0);
    linkStmt.run("sum_condensed_1", "sum_leaf_b", 1);
    linkStmt.run("sum_condensed_2", "sum_condensed_1", 0);

    runLcmMigrations(db);

    const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{
      name?: string;
    }>;
    expect(summaryColumns.some((column) => column.name === "depth")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "earliest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "latest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_token_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "source_message_token_count")).toBe(true);

    const depthRows = db
      .prepare(
        `SELECT summary_id, depth, earliest_at, latest_at, descendant_count,
                descendant_token_count, source_message_token_count
         FROM summaries
         ORDER BY summary_id`,
      )
      .all() as Array<{
      summary_id: string;
      depth: number;
      earliest_at: string | null;
      latest_at: string | null;
      descendant_count: number;
      descendant_token_count: number;
      source_message_token_count: number;
    }>;
    const depthBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.depth]));
    const earliestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.earliest_at]));
    const latestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.latest_at]));
    const descendantCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_count]),
    );
    const descendantTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_token_count]),
    );
    const sourceMessageTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.source_message_token_count]),
    );

    expect(depthBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(depthBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(depthBySummaryId.get("sum_condensed_1")).toBe(1);
    expect(depthBySummaryId.get("sum_condensed_2")).toBe(2);
    expect(depthBySummaryId.get("sum_condensed_orphan")).toBe(1);

    const leafAEarliest = earliestBySummaryId.get("sum_leaf_a");
    const leafALatest = latestBySummaryId.get("sum_leaf_a");
    const leafBEarliest = earliestBySummaryId.get("sum_leaf_b");
    const leafBLatest = latestBySummaryId.get("sum_leaf_b");
    const condensed1Earliest = earliestBySummaryId.get("sum_condensed_1");
    const condensed1Latest = latestBySummaryId.get("sum_condensed_1");
    const condensed2Earliest = earliestBySummaryId.get("sum_condensed_2");
    const condensed2Latest = latestBySummaryId.get("sum_condensed_2");

    expect(leafAEarliest).toContain("2026-01-01");
    expect(leafALatest).toContain("2026-01-01");
    expect(leafBEarliest).toContain("2026-01-01");
    expect(leafBLatest).toContain("2026-01-01");
    expect(condensed1Earliest).toContain("2026-01-01");
    expect(condensed1Latest).toContain("2026-01-01");
    expect(condensed2Earliest).toContain("2026-01-01");
    expect(condensed2Latest).toContain("2026-01-01");

    expect(new Date(leafAEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafALatest as string).getTime(),
    );
    expect(new Date(leafBEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed1Latest as string).getTime(),
    );
    expect(new Date(condensed2Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed2Latest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafAEarliest as string).getTime(),
    );
    expect(new Date(condensed1Latest as string).getTime()).toBeGreaterThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(earliestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");
    expect(latestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");

    expect(descendantCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_condensed_1")).toBe(2);
    expect(descendantCountBySummaryId.get("sum_condensed_2")).toBe(3);
    expect(descendantCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(descendantTokenCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_1")).toBe(20);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_2")).toBe(30);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_a")).toBe(10);
    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_b")).toBe(5);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_1")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_2")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);
  });

  it("adds cross-session metadata columns and digest table for legacy databases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy-cross-session.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    runLcmMigrations(db, { fts5Available: false });

    const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{
      name?: string;
    }>;
    expect(conversationColumns.some((column) => column.name === "bootstrapped_at")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "agent_scope")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "provider")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "source_label")).toBe(true);

    const digestColumns = db.prepare(`PRAGMA table_info(conversation_digests)`).all() as Array<{
      name?: string;
    }>;
    const digestColumnNames = new Set(digestColumns.map((column) => column.name));
    expect(digestColumnNames.has("conversation_id")).toBe(true);
    expect(digestColumnNames.has("agent_scope")).toBe(true);
    expect(digestColumnNames.has("provider")).toBe(true);
    expect(digestColumnNames.has("source_label")).toBe(true);
    expect(digestColumnNames.has("digest_text")).toBe(true);
    expect(digestColumnNames.has("token_count")).toBe(true);
    expect(digestColumnNames.has("last_context_ord")).toBe(true);
    expect(digestColumnNames.has("earliest_at")).toBe(true);
    expect(digestColumnNames.has("latest_at")).toBe(true);
    expect(digestColumnNames.has("updated_at")).toBe(true);

    db.prepare(`INSERT INTO conversations (session_id, title) VALUES (?, ?)`).run(
      "legacy-cross-session",
      "Legacy",
    );
    db.prepare(
      `INSERT INTO conversation_digests (
         conversation_id, agent_scope, provider, source_label, digest_text,
         token_count, last_context_ord, earliest_at, latest_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, "cpto", "slack", "#openclaw-fork", "digest", 120, 4, "2026-01-01", "2026-01-02");

    expect(() => {
      db.prepare(
        `INSERT INTO conversation_digests (
           conversation_id, agent_scope, provider, source_label, digest_text,
           token_count, last_context_ord, earliest_at, latest_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(1, "cpto", "slack", "#openclaw-fork", "digest-2", 110, 5, "2026-01-01", "2026-01-03");
    }).toThrow();
  });

  it("round-trips conversation metadata and updates existing conversation fields", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "conversation-metadata.db");
    const db = getLcmConnection(dbPath);
    runLcmMigrations(db, { fts5Available: false });

    const store = new ConversationStore(db, { fts5Available: false });
    const created = await store.createConversation({
      sessionId: "agent:cpto:session-1",
      title: "Cross-session test",
      agentScope: "cpto",
      provider: "slack",
      sourceLabel: "#openclaw-fork",
    });

    expect(created.agentScope).toBe("cpto");
    expect(created.provider).toBe("slack");
    expect(created.sourceLabel).toBe("#openclaw-fork");

    await store.updateConversationMetadata(created.conversationId, {
      provider: "discord",
      sourceLabel: "DM: James",
    });

    const updated = await store.getConversation(created.conversationId);
    expect(updated).not.toBeNull();
    expect(updated?.agentScope).toBe("cpto");
    expect(updated?.provider).toBe("discord");
    expect(updated?.sourceLabel).toBe("DM: James");

    const existing = await store.getOrCreateConversation("agent:cpto:session-1", undefined, {
      agentScope: "cpto-updated",
    });
    expect(existing.conversationId).toBe(created.conversationId);
    expect(existing.agentScope).toBe("cpto-updated");
    expect(existing.provider).toBe("discord");
    expect(existing.sourceLabel).toBe("DM: James");
  });

  it("skips FTS tables when fts5 is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "no-fts.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const ftsTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
      .all() as Array<{ name: string }>;

    expect(ftsTables).toEqual([]);
  });
});
