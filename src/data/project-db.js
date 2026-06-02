let syncTimer = null;
let syncInFlight = false;
let queuedSnapshot = null;
let lastSyncedSignature = "";
export const WORKSPACE_PROJECT_ID = "__workspace__";

function buildSignature(snapshot) {
  return JSON.stringify({
    collarRows: snapshot.collarRows,
    surveyRows: snapshot.surveyRows,
    geologyRows: snapshot.geologyRows,
    colorFiles: snapshot.colorFiles,
    boreholes: snapshot.boreholes
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Request fehlgeschlagen: ${response.status}`);
  }

  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request fehlgeschlagen: ${response.status}`);
  }

  return response.json();
}

async function flushSyncQueue() {
  if (syncInFlight || !queuedSnapshot) return;

  const snapshot = queuedSnapshot;
  const signature = buildSignature(snapshot);
  if (signature === lastSyncedSignature) {
    queuedSnapshot = null;
    return;
  }

  queuedSnapshot = null;
  syncInFlight = true;

  try {
    await postJson("/api/project-db/sync", snapshot);
    lastSyncedSignature = signature;
  } catch (error) {
    console.warn("[project-db]", error.message);
  } finally {
    syncInFlight = false;
    if (queuedSnapshot) {
      syncTimer = window.setTimeout(() => {
        syncTimer = null;
        flushSyncQueue();
      }, 150);
    }
  }
}

export function scheduleProjectDbSync(snapshot) {
  queuedSnapshot = snapshot;
  if (syncTimer) {
    window.clearTimeout(syncTimer);
  }

  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    flushSyncQueue();
  }, 300);
}

export function resetProjectDbSyncSignature() {
  lastSyncedSignature = "";
}

export async function loadWorkspaceProject() {
  return getJson("/api/project-db/workspace");
}

export async function listSavedProjects() {
  return getJson("/api/project-db/projects");
}

export async function loadSavedProject(projectId) {
  return getJson(`/api/project-db/projects/${encodeURIComponent(projectId)}`);
}

export async function saveNamedProject(snapshot) {
  return postJson("/api/project-db/projects", snapshot);
}
