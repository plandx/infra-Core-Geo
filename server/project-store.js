import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildProjectCounts, buildProjectRecords } from "./project-records.js";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dbDir = path.join(rootDir, ".project-db");
const workspaceDbPath = path.join(dbDir, "workspace.sqlite");
const projectsDir = path.join(dbDir, "projects");
export const WORKSPACE_PROJECT_ID = "__workspace__";

let workspaceDb = null;

const status = {
  available: true,
  initialized: false,
  path: workspaceDbPath,
  projectsDir,
  lastSyncAt: null,
  lastRecordCount: 0,
  lastError: null
};

function sanitizeProjectName(projectId) {
  return String(projectId ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function projectDbPathFor(projectId) {
  return path.join(projectsDir, `${sanitizeProjectName(projectId)}.sqlite`);
}

function initSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS project_snapshot (
      project_id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      dataset TEXT,
      borehole_id TEXT,
      row_index INTEGER,
      metadata_json TEXT NOT NULL,
      document TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_records_borehole ON project_records(borehole_id);
    CREATE INDEX IF NOT EXISTS idx_project_records_kind ON project_records(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS project_records_fts USING fts5(
      id UNINDEXED,
      document,
      tokenize = 'unicode61'
    );
  `);
}

function ensureDirectories() {
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
}

function ensureWorkspaceDb() {
  if (workspaceDb) return workspaceDb;

  ensureDirectories();
  workspaceDb = new DatabaseSync(workspaceDbPath);
  initSchema(workspaceDb);
  status.initialized = true;
  status.lastError = null;
  return workspaceDb;
}

function openProjectDb(filePath) {
  ensureDirectories();
  const database = new DatabaseSync(filePath);
  initSchema(database);
  return database;
}

// Read path: open an existing project DB without running the (write-heavy)
// schema bootstrap. Existing project files already carry the schema.
function openProjectDbForRead(filePath) {
  return new DatabaseSync(filePath, { readOnly: true });
}

function beginTransaction(database) {
  database.exec("BEGIN");
}

function commitTransaction(database) {
  database.exec("COMMIT");
}

function rollbackTransaction(database) {
  database.exec("ROLLBACK");
}

function writeSnapshotToDb(database, snapshot) {
  const records = buildProjectRecords(snapshot);
  const counts = buildProjectCounts(snapshot, records);

  const upsertSnapshot = database.prepare(`
    INSERT INTO project_snapshot (project_id, generated_at, summary_json, snapshot_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      generated_at = excluded.generated_at,
      summary_json = excluded.summary_json,
      snapshot_json = excluded.snapshot_json
  `);
  const clearRecords = database.prepare("DELETE FROM project_records");
  const clearFts = database.prepare("DELETE FROM project_records_fts");
  const insertRecord = database.prepare(`
    INSERT INTO project_records (
      id, kind, dataset, borehole_id, row_index, metadata_json, document
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO project_records_fts (id, document) VALUES (?, ?)
  `);

  beginTransaction(database);
  try {
    upsertSnapshot.run(
      counts.projectId,
      counts.generatedAt,
      JSON.stringify(counts),
      JSON.stringify(snapshot)
    );
    clearRecords.run();
    clearFts.run();

    for (const record of records) {
      insertRecord.run(
        record.id,
        record.metadata.kind ?? "",
        record.metadata.dataset ?? "",
        record.metadata.boreholeId ?? "",
        Number.isFinite(record.metadata.rowIndex) ? record.metadata.rowIndex : null,
        JSON.stringify(record.metadata),
        record.document
      );
      insertFts.run(record.id, record.document);
    }

    commitTransaction(database);
  } catch (error) {
    rollbackTransaction(database);
    throw error;
  }

  return { records, counts };
}

function readSnapshotFromDb(database) {
  const row = database.prepare(`
    SELECT project_id, generated_at, summary_json, snapshot_json
    FROM project_snapshot
    LIMIT 1
  `).get();

  if (!row) {
    return null;
  }

  return {
    projectId: row.project_id,
    generatedAt: row.generated_at,
    summary: JSON.parse(row.summary_json),
    snapshot: JSON.parse(row.snapshot_json)
  };
}

function tokenQuery(queryText) {
  const tokens = String(queryText ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export async function initProjectStore() {
  try {
    ensureWorkspaceDb();
  } catch (error) {
    status.available = false;
    status.lastError = error.message;
  }

  return status;
}

export async function syncProjectStore(snapshot) {
  try {
    const database = ensureWorkspaceDb();
    const normalized = { ...snapshot, projectId: WORKSPACE_PROJECT_ID };
    const { records, counts } = writeSnapshotToDb(database, normalized);

    status.available = true;
    status.initialized = true;
    status.lastError = null;
    status.lastRecordCount = records.length;
    status.lastSyncAt = new Date().toISOString();

    return {
      ok: true,
      status: getProjectStoreStatus(),
      counts
    };
  } catch (error) {
    status.available = false;
    status.lastError = error.message;
    return {
      ok: false,
      status: getProjectStoreStatus(),
      counts: null
    };
  }
}

export async function saveProjectSnapshot(snapshot) {
  let database = null;

  try {
    const projectId = sanitizeProjectName(snapshot.projectId);
    if (!projectId || projectId === WORKSPACE_PROJECT_ID) {
      throw new Error("Ungueltiger Projektname.");
    }

    database = openProjectDb(projectDbPathFor(projectId));
    const normalized = { ...snapshot, projectId };
    const { records, counts } = writeSnapshotToDb(database, normalized);

    status.available = true;
    status.initialized = true;
    status.lastError = null;
    status.lastRecordCount = records.length;
    status.lastSyncAt = new Date().toISOString();

    return {
      ok: true,
      status: getProjectStoreStatus(),
      counts
    };
  } catch (error) {
    return {
      ok: false,
      status: getProjectStoreStatus(),
      counts: null,
      error: error.message
    };
  } finally {
    database?.close?.();
  }
}

export async function listProjectSnapshots() {
  try {
    ensureDirectories();
    const files = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sqlite"))
      .map((entry) => entry.name);

    const projects = [];
    for (const file of files) {
      const database = openProjectDbForRead(path.join(projectsDir, file));
      try {
        const row = readSnapshotFromDb(database);
        if (row) {
          projects.push({
            projectId: row.projectId,
            generatedAt: row.generatedAt,
            summary: row.summary,
            filename: file
          });
        }
      } finally {
        database.close?.();
      }
    }

    projects.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));

    return {
      ok: true,
      status: getProjectStoreStatus(),
      projects
    };
  } catch (error) {
    return {
      ok: false,
      status: getProjectStoreStatus(),
      projects: [],
      error: error.message
    };
  }
}

export async function loadWorkspaceSnapshot() {
  try {
    const database = ensureWorkspaceDb();
    const row = readSnapshotFromDb(database);

    if (!row) {
      return {
        ok: false,
        status: getProjectStoreStatus(),
        snapshot: null,
        error: "Kein Arbeitsstand gefunden."
      };
    }

    return {
      ok: true,
      status: getProjectStoreStatus(),
      projectId: row.projectId,
      generatedAt: row.generatedAt,
      summary: row.summary,
      snapshot: row.snapshot
    };
  } catch (error) {
    return {
      ok: false,
      status: getProjectStoreStatus(),
      snapshot: null,
      error: error.message
    };
  }
}

export async function loadProjectSnapshot(projectId) {
  let database = null;

  try {
    const sanitized = sanitizeProjectName(projectId);
    if (!sanitized) {
      throw new Error("Projektname fehlt.");
    }

    const targetPath = projectDbPathFor(sanitized);
    if (!existsSync(targetPath)) {
      return {
        ok: false,
        status: getProjectStoreStatus(),
        snapshot: null,
        error: "Projekt nicht gefunden."
      };
    }

    database = openProjectDbForRead(targetPath);
    const row = readSnapshotFromDb(database);

    if (!row) {
      return {
        ok: false,
        status: getProjectStoreStatus(),
        snapshot: null,
        error: "Projekt nicht gefunden."
      };
    }

    return {
      ok: true,
      status: getProjectStoreStatus(),
      projectId: row.projectId,
      generatedAt: row.generatedAt,
      summary: row.summary,
      snapshot: row.snapshot
    };
  } catch (error) {
    return {
      ok: false,
      status: getProjectStoreStatus(),
      snapshot: null,
      error: error.message
    };
  } finally {
    database?.close?.();
  }
}

export async function searchProjectStore(queryText, limit = 8) {
  try {
    const database = ensureWorkspaceDb();
    const ftsQuery = tokenQuery(queryText);

    if (!ftsQuery) {
      return {
        ok: true,
        status: getProjectStoreStatus(),
        results: []
      };
    }

    const rows = database.prepare(`
      SELECT
        r.id,
        r.document,
        r.metadata_json,
        bm25(project_records_fts) AS score
      FROM project_records_fts
      JOIN project_records r ON r.id = project_records_fts.id
      WHERE project_records_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, limit);

    return {
      ok: true,
      status: getProjectStoreStatus(),
      results: rows.map((row) => ({
        id: row.id,
        document: row.document,
        metadata: JSON.parse(row.metadata_json),
        score: row.score
      }))
    };
  } catch (error) {
    return {
      ok: false,
      status: getProjectStoreStatus(),
      results: [],
      error: error.message
    };
  }
}

export function getProjectStoreStatus() {
  return { ...status };
}
