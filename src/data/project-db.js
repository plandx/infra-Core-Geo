let syncTimer = null;
let syncInFlight = false;
let queuedSnapshot = null;
let lastSyncedSignature = "";
export const WORKSPACE_PROJECT_ID = "__workspace__";

// Cheap, non-cryptographic content fingerprint (FNV-1a, 32-bit). Combined
// with the body length to make accidental collisions practically impossible
// for our use. Lets us dedup identical syncs without a second full
// JSON.stringify of the (potentially large) dataset.
function fingerprint(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${body.length}:${h.toString(16)}`;
}

async function postJson(url, payload) {
  return postJsonBody(url, JSON.stringify(payload));
}

async function postJsonBody(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body
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
  queuedSnapshot = null;

  // Serialize once; reuse the same body for dedup fingerprint and request.
  const body = JSON.stringify(snapshot);
  const signature = fingerprint(body);
  if (signature === lastSyncedSignature) {
    return;
  }

  syncInFlight = true;

  try {
    await postJsonBody("/api/project-db/sync", body);
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
