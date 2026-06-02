import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProjectStoreStatus,
  initProjectStore,
  listProjectSnapshots,
  loadProjectSnapshot,
  loadWorkspaceSnapshot,
  saveProjectSnapshot,
  searchProjectStore,
  syncProjectStore
} from "./server/project-store.js";

const host = "127.0.0.1";
const port = 4173;
const rootDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".lfc", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"]
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function resolvePath(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  const safePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const targetPath = path.normalize(path.join(rootDir, safePath));

  // Guard against path traversal, including sibling dirs like "<rootDir>-evil".
  if (targetPath !== rootDir && !targetPath.startsWith(rootDir + path.sep)) {
    return null;
  }

  if (!existsSync(targetPath)) {
    return null;
  }

  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    const indexPath = path.join(targetPath, "index.html");
    return existsSync(indexPath) ? indexPath : null;
  }

  return targetPath;
}

const server = http.createServer((request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (method === "GET" && url.pathname === "/api/project-db/status") {
    sendJson(response, 200, getProjectStoreStatus());
    return;
  }

  if (method === "GET" && url.pathname === "/api/project-db/projects") {
    listProjectSnapshots()
      .then((result) => sendJson(response, result.ok ? 200 : 503, result))
      .catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }

  if (method === "GET" && url.pathname === "/api/project-db/workspace") {
    loadWorkspaceSnapshot()
      .then((result) => sendJson(response, result.ok ? 200 : 404, result))
      .catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/api/project-db/projects/")) {
    const projectId = decodeURIComponent(url.pathname.slice("/api/project-db/projects/".length));
    loadProjectSnapshot(projectId)
      .then((result) => sendJson(response, result.ok ? 200 : 404, result))
      .catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }

  if (method === "POST" && url.pathname === "/api/project-db/sync") {
    readJsonBody(request)
      .then(async (payload) => {
        const result = await syncProjectStore(payload);
        sendJson(response, result.ok ? 200 : 503, result);
      })
      .catch((error) => {
        sendJson(response, 400, { ok: false, error: error.message });
      });
    return;
  }

  if (method === "POST" && url.pathname === "/api/project-db/projects") {
    readJsonBody(request)
      .then(async (payload) => {
        const result = await saveProjectSnapshot(payload);
        sendJson(response, result.ok ? 200 : 503, result);
      })
      .catch((error) => {
        sendJson(response, 400, { ok: false, error: error.message });
      });
    return;
  }

  if (method === "POST" && url.pathname === "/api/project-db/search") {
    readJsonBody(request)
      .then(async (payload) => {
        const query = String(payload.query ?? "").trim();
        if (!query) {
          sendJson(response, 400, { ok: false, error: "query fehlt" });
          return;
        }

        const result = await searchProjectStore(query, Number(payload.limit) || 8);
        sendJson(response, result.ok ? 200 : 503, result);
      })
      .catch((error) => {
        sendJson(response, 400, { ok: false, error: error.message });
      });
    return;
  }


  const filePath = resolvePath(request.url ?? "/");

  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": mimeTypes.get(extension) ?? "application/octet-stream",
    "Cache-Control": "no-store"
  });

  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Borehole viewer available at http://${host}:${port}`);
});

initProjectStore().catch((error) => {
  console.error(`[project-store] ${error.message}`);
});
