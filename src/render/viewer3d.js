/**
 * Three.js WebGL 3D viewer for borehole trajectories.
 * Loaded lazily on first use; requires internet for CDN imports.
 */

let THREE = null;
let OrbitControls = null;

async function ensureThree() {
  if (THREE) return;
  try {
    const t = await import('three');
    const oc = await import('three/addons/controls/OrbitControls.js');
    THREE = t;
    OrbitControls = oc.OrbitControls;
  } catch (e) {
    throw new Error('Three.js konnte nicht geladen werden. Bitte Internetverbindung prüfen.');
  }
}

export class Viewer3D {
  constructor(canvas) {
    this._canvas    = canvas;
    this._renderer  = null;
    this._scene     = null;
    this._camera    = null;
    this._controls  = null;
    this._raf       = null;
    this._objects   = [];   // disposable objects
    this._targets   = [];   // {mesh, id} for click detection
    this._raycaster = null;
    this._ready     = false;
    this._centroid  = null;
  }

  async init() {
    await ensureThree();

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: false
    });
    this._renderer.setClearColor(0xFAF9F8, 1);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._scene = new THREE.Scene();
    this._scene.fog = new THREE.FogExp2(0xFAF9F8, 0.00003);

    const w = this._canvas.clientWidth  || 800;
    const h = this._canvas.clientHeight || 600;

    this._camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100000);
    this._camera.position.set(500, 400, 500);
    this._camera.lookAt(0, 0, 0);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.screenSpacePanning = false;
    this._controls.minDistance = 5;
    this._controls.maxDistance = 20000;

    // Ambient + directional light
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(1, 2, 1).normalize();
    this._scene.add(sun);

    this._raycaster = new THREE.Raycaster();
    this._raycaster.params.Line.threshold = 4;

    this._ready = true;
    this._loop();
    return this;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    this._resize();
    if (this._controls) this._controls.update();
    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  _resize() {
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (!w || !h) return;
    if (this._canvas.width === w && this._canvas.height === h) return;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  // ─── Scene building ──────────────────────────────────────────────────────

  setBoreholes(boreholes, selectedId, geologyById = new Map(), logColumn = '', colorFiles = [], diameter = 0) {
    if (!this._ready) return;
    this._clearBoreholes();
    if (!boreholes.length) return;

    // Compute centroid for coordinate normalization
    let cx = 0, cy = 0, cz = 0;
    for (const bh of boreholes) { cx += bh.collar.x; cy += bh.collar.y; cz += bh.collar.z; }
    cx /= boreholes.length; cy /= boreholes.length; cz /= boreholes.length;
    this._centroid = { x: cx, y: cy, z: cz };

    const maxDepth = Math.max(...boreholes.map((bh) => bh.totalDepth), 100);

    // Ground grid centred on borehole cloud
    this._addGrid(maxDepth * 4);

    const radius = diameter > 0 ? diameter / 2 : 0;
    // Adaptive tube quality: fewer segments for large datasets
    const radialSeg = boreholes.length > 100 ? 5 : boreholes.length > 40 ? 7 : 10;

    for (const bh of boreholes) {
      const isSelected = bh.id === selectedId;
      const intervals  = geologyById.get(bh.normalizedId) ?? [];
      this._addBorehole(bh, isSelected, intervals, logColumn, colorFiles, cx, cy, cz, radius, radialSeg);
    }

    // Focus camera on the cloud
    const camDist = maxDepth * 1.8;
    this._camera.position.set(camDist * 0.7, camDist * 0.5, camDist * 0.7);
    this._controls.target.set(0, -maxDepth * 0.3, 0);
    this._controls.update();
  }

  _addBorehole(bh, isSelected, intervals, logColumn, colorFiles, cx, cy, cz, radius = 0, radialSeg = 8) {
    // Convert world coords to scene coords (Y-up, Z-north)
    const toScene = (p) => ({
      x: p.x - cx,
      y: p.z - cz,   // elevation as Y
      z: -(p.y - cy) // north as -Z
    });

    const scenePts = bh.points.map(toScene);

    if (intervals.length > 0) {
      this._addIntervalSegments(bh, intervals, scenePts, logColumn, colorFiles, isSelected, radius, radialSeg);
    } else {
      const col = isSelected ? 0x0078D4 : 0xA19F9D;
      if (radius > 0) {
        this._addTube(scenePts, col, radius, radialSeg);
      } else {
        this._addLine(scenePts, col, isSelected ? 2.5 : 1.2);
      }
    }

    // Collar sphere
    const collarScene = toScene(bh.points[0]);
    const col = isSelected ? 0x0078D4 : 0x605E5C;
    const sphereGeom = new THREE.SphereGeometry(isSelected ? 6 : 3.5, 12, 8);
    const sphereMat  = new THREE.MeshBasicMaterial({ color: col });
    const sphere     = new THREE.Mesh(sphereGeom, sphereMat);
    sphere.position.set(collarScene.x, collarScene.y, collarScene.z);
    sphere.userData  = { bhId: bh.id, isBorehole: true };
    this._scene.add(sphere);
    this._objects.push(sphere);
    this._targets.push(sphere);

    // Label (only for selected or small datasets)
    if (isSelected) {
      this._addLabel(bh.id, collarScene);
    }
  }

  _addIntervalSegments(bh, intervals, scenePts, logColumn, colorFiles, isSelected, radius = 0, radialSeg = 8) {
    for (const iv of intervals) {
      const colValue = logColumn && iv.raw?.[logColumn]
        ? String(iv.raw[logColumn])
        : (iv.subUnit || iv.unit || '');

      const colorCss  = this._resolveColor(colValue, logColumn, colorFiles);
      const threeColor = new THREE.Color(colorCss);
      const segFrom = interpolateScene(scenePts, bh.points, iv.from);
      const segTo   = interpolateScene(scenePts, bh.points, iv.to);
      const pts = [segFrom, segTo];

      if (radius > 0) {
        this._addTube(pts, threeColor.getHex(), radius, radialSeg);
      } else {
        this._addLine(pts, threeColor.getHex(), isSelected ? 3 : 2);
      }
    }
  }

  _addTube(scenePts, color, radius, radialSeg = 8) {
    if (scenePts.length < 2) return;

    const v3 = scenePts.map((p) => new THREE.Vector3(p.x, p.y, p.z));

    // Build a CurvePath of linear segments so the tube follows the exact trajectory
    const path = new THREE.CurvePath();
    for (let i = 1; i < v3.length; i++) {
      path.add(new THREE.LineCurve3(v3[i - 1], v3[i]));
    }

    const lengthSeg = Math.max(v3.length - 1, 1) * 2;
    let geom;
    try {
      geom = new THREE.TubeGeometry(path, lengthSeg, radius, radialSeg, false);
    } catch {
      // Fallback to line if geometry fails (e.g. zero-length segment)
      this._addLine(scenePts, color, 2);
      return;
    }

    const mat  = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.isBorehole = true;
    this._scene.add(mesh);
    this._objects.push(mesh);
  }

  _resolveColor(value, logColumn, colorFiles) {
    if (value && colorFiles.length) {
      const ordered = logColumn
        ? [...colorFiles.filter((cf) => cf.columns.includes(logColumn)),
           ...colorFiles.filter((cf) => cf.columns.length === 0)]
        : colorFiles;

      for (const cf of ordered) {
        const direct = cf.colorMap.get(value);
        if (direct) return `rgb(${direct.r},${direct.g},${direct.b})`;
        for (const [key, c] of cf.colorMap) {
          if (value.length > 2 && (key.includes(value) || value.includes(key)))
            return `rgb(${c.r},${c.g},${c.b})`;
        }
      }
    }
    // Hash fallback
    let h = 0;
    for (const ch of value || 'interval') { h = (h << 5) - h + ch.charCodeAt(0); h |= 0; }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue},52%,62%)`;
  }

  _addLine(scenePts, color, width = 1.5) {
    const positions = new Float32Array(scenePts.length * 3);
    for (let i = 0; i < scenePts.length; i++) {
      positions[i * 3]     = scenePts[i].x;
      positions[i * 3 + 1] = scenePts[i].y;
      positions[i * 3 + 2] = scenePts[i].z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat  = new THREE.LineBasicMaterial({ color, linewidth: width });
    const line = new THREE.Line(geom, mat);
    line.userData.isBorehole = true;
    this._scene.add(line);
    this._objects.push(line);
  }

  _addLabel(text, pos) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,120,212,0.88)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 248, 40, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 24);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(pos.x + 5, pos.y + 12, pos.z);
    sprite.scale.set(60, 14, 1);
    sprite.userData.isBorehole = true;
    this._scene.add(sprite);
    this._objects.push(sprite);
  }

  _addGrid(size) {
    const divisions = 20;
    const grid = new THREE.GridHelper(size, divisions, 0xC8C6C4, 0xEDEBE9);
    grid.userData.isGrid = true;
    this._scene.add(grid);
    this._objects.push(grid);
  }

  _clearBoreholes() {
    for (const obj of this._objects) {
      this._scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    }
    this._objects = [];
    this._targets = [];
  }

  // ─── Interaction ──────────────────────────────────────────────────────────

  pick(clientX, clientY) {
    if (!this._ready || !this._targets.length) return null;
    const rect = this._canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left)  / rect.width)  * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(mouse, this._camera);
    const hits = this._raycaster.intersectObjects(this._targets, false);
    return hits.length ? hits[0].object.userData.bhId ?? null : null;
  }

  focusBorehole(bhId) {
    if (!this._ready) return;
    const sphere = this._targets.find((t) => t.userData?.bhId === bhId);
    if (!sphere) return;

    const collarPos = sphere.position.clone();
    // Use current distance to target as a hint for zoom level, capped nicely
    const curDist = this._camera.position.distanceTo(this._controls.target);
    const zoomDist = Math.max(40, Math.min(curDist * 0.55, 400));

    this._controls.target.copy(collarPos);
    this._camera.position.set(
      collarPos.x + zoomDist * 0.7,
      collarPos.y + zoomDist * 0.45,
      collarPos.z + zoomDist * 0.7
    );
    this._controls.update();
  }

  fitAll() {
    if (!this._centroid || !this._ready) return;
    const box = new THREE.Box3().setFromObject(this._scene);
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist   = maxDim / (2 * Math.tan(this._camera.fov * Math.PI / 360));
    this._camera.position.copy(center).add(new THREE.Vector3(dist * 0.7, dist * 0.4, dist * 0.7));
    this._controls.target.copy(center);
    this._controls.update();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._clearBoreholes();
    if (this._renderer) { this._renderer.dispose(); this._renderer = null; }
    this._ready = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function interpolateScene(scenePts, worldPts, targetMd) {
  if (!worldPts.length) return { x: 0, y: 0, z: 0 };
  for (let i = 1; i < worldPts.length; i++) {
    const a = worldPts[i - 1], b = worldPts[i];
    if (targetMd <= b.md) {
      const t = (b.md === a.md) ? 0 : (targetMd - a.md) / (b.md - a.md);
      const sa = scenePts[i - 1], sb = scenePts[i];
      return {
        x: sa.x + (sb.x - sa.x) * t,
        y: sa.y + (sb.y - sa.y) * t,
        z: sa.z + (sb.z - sa.z) * t
      };
    }
  }
  return scenePts[scenePts.length - 1];
}
