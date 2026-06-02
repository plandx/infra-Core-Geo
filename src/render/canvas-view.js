const COLORS = {
  background: "#FAF9F8",
  grid: "rgba(0, 0, 0, 0.06)",
  axis: "rgba(0, 0, 0, 0.18)",
  trace: "rgba(0, 120, 212, 0.22)",
  traceSelected: "#0078D4",
  collar: "#0078D4",
  collarMuted: "rgba(0, 120, 212, 0.30)",
  label: "#323130",
  measurement: "#C42B1C",
  hover: "#106EBE"
};

function createProjector(mode) {
  if (mode === "plan") {
    return (point) => ({ x: point.x, y: point.y });
  }

  if (mode === "profile") {
    return (point, borehole) => ({
      x: Math.hypot(point.x - borehole.collar.x, point.y - borehole.collar.y),
      y: point.z
    });
  }

  return (point) => ({ x: point.x, y: point.y });
}

function getProjectedBounds(boreholes, projector) {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity
  };

  for (const borehole of boreholes) {
    for (const point of borehole.points) {
      const projected = projector(point, borehole);
      bounds.minX = Math.min(bounds.minX, projected.x);
      bounds.maxX = Math.max(bounds.maxX, projected.x);
      bounds.minY = Math.min(bounds.minY, projected.y);
      bounds.maxY = Math.max(bounds.maxY, projected.y);
    }
  }

  return bounds;
}

function mapToCanvas(projected, bounds, width, height, padding) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const originX = (width - spanX * scale) / 2;
  const originY = (height - spanY * scale) / 2;

  return {
    x: originX + (projected.x - bounds.minX) * scale,
    y: height - originY - (projected.y - bounds.minY) * scale,
    scale
  };
}

function applyViewTransform(point, width, height, camera) {
  const centerX = width / 2;
  const centerY = height / 2;

  return {
    x: centerX + (point.x - centerX) * camera.zoom + camera.panX,
    y: centerY + (point.y - centerY) * camera.zoom + camera.panY
  };
}

function invertViewTransform(point, width, height, camera) {
  const centerX = width / 2;
  const centerY = height / 2;

  return {
    x: centerX + (point.x - centerX - camera.panX) / camera.zoom,
    y: centerY + (point.y - centerY - camera.panY) / camera.zoom
  };
}

function createScene(width, height, bounds, padding, camera) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const originX = (width - spanX * scale) / 2;
  const originY = (height - spanY * scale) / 2;

  function projectedToBase(projected) {
    return {
      x: originX + (projected.x - bounds.minX) * scale,
      y: height - originY - (projected.y - bounds.minY) * scale
    };
  }

  return {
    scale,
    projectedToScreen(projected) {
      return applyViewTransform(projectedToBase(projected), width, height, camera);
    },
    screenToProjected(screenPoint) {
      const basePoint = invertViewTransform(screenPoint, width, height, camera);
      return {
        x: bounds.minX + (basePoint.x - originX) / scale,
        y: bounds.minY + (height - originY - basePoint.y) / scale
      };
    }
  };
}

function drawFrame(context, width, height, padding) {
  context.save();
  context.strokeStyle = COLORS.axis;
  context.lineWidth = 1;
  context.strokeRect(padding / 2, padding / 2, width - padding, height - padding);
  context.restore();
}

function drawMeasurement(context, scene, measurement) {
  if (!measurement?.start || !measurement?.end) {
    return;
  }

  const start = scene.projectedToScreen(measurement.start);
  const end = scene.projectedToScreen(measurement.end);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;

  context.save();
  context.strokeStyle = COLORS.measurement;
  context.fillStyle = COLORS.measurement;
  context.lineWidth = 2;
  context.setLineDash([7, 5]);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.setLineDash([]);

  context.beginPath();
  context.arc(start.x, start.y, 4, 0, Math.PI * 2);
  context.arc(end.x, end.y, 4, 0, Math.PI * 2);
  context.fill();

  if (measurement.label) {
    context.font = "600 12px Segoe UI Variable, Segoe UI, sans-serif";
    context.fillStyle = COLORS.measurement;
    context.fillText(measurement.label, midX + 8, midY - 8);
  }
  context.restore();
}

function drawPlanMode(context, width, height, padding, boreholes, selectedId, showLabels, showGrid, scene, state, hitTargets) {
  const projector = createProjector("plan");

  if (showGrid) {
    drawGrid(context, width, height);
  }

  for (const borehole of boreholes) {
    const isSelected = borehole.id === selectedId;
    const collarProjected = projector(borehole.points[0], borehole);
    const collar = scene.projectedToScreen(collarProjected);

    context.fillStyle = isSelected ? COLORS.traceSelected : COLORS.collarMuted;
    context.beginPath();
    context.arc(collar.x, collar.y, isSelected ? 5 : 2.5, 0, Math.PI * 2);
    context.fill();
    hitTargets.push({ type: "borehole", id: borehole.id, x: collar.x, y: collar.y, radius: isSelected ? 10 : 8 });

    if (isSelected || (showLabels && boreholes.length <= 150)) {
      context.fillStyle = COLORS.label;
      context.font = isSelected ? "600 12px Segoe UI" : "11px Segoe UI";
      context.fillText(borehole.id, collar.x + 8, collar.y - 8);
    }
  }

  const selected = boreholes.find((entry) => entry.id === selectedId);
  if (selected && selected.points.length > 1) {
    context.beginPath();
    for (let i = 0; i < selected.points.length; i++) {
      const mapped = scene.projectedToScreen(projector(selected.points[i], selected));
      if (i === 0) context.moveTo(mapped.x, mapped.y);
      else context.lineTo(mapped.x, mapped.y);
    }
    context.strokeStyle = COLORS.traceSelected;
    context.lineWidth = 2.4;
    context.stroke();
  }

  if (state.hoveredTarget) {
    context.save();
    context.strokeStyle = COLORS.hover;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(state.hoveredTarget.x, state.hoveredTarget.y, state.hoveredTarget.radius + 4, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  drawMeasurement(context, scene, state.measurement);
  drawFrame(context, width, height, padding);
}

function drawDetailMode(context, width, height, padding, borehole, mode, showGrid, showLabels, scene, state, hitTargets) {
  const projector = createProjector(mode);

  if (showGrid) {
    drawGrid(context, width, height);
  }

  const screenPoints = borehole.points.map((point) => {
    const projected = projector(point, borehole);
    const mapped = scene.projectedToScreen(projected);
    return { mapped, projected, md: point.md };
  });

  context.beginPath();
  for (let i = 0; i < screenPoints.length; i++) {
    const { x, y } = screenPoints[i].mapped;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = COLORS.traceSelected;
  context.lineWidth = 2.8;
  context.stroke();

  for (let index = 0; index < screenPoints.length; index++) {
    const { mapped, projected } = screenPoints[index];
    context.fillStyle = index === 0 ? COLORS.collar : COLORS.traceSelected;
    context.beginPath();
    context.arc(mapped.x, mapped.y, index === 0 ? 5 : 3, 0, Math.PI * 2);
    context.fill();
    hitTargets.push({
      type: "point",
      id: borehole.id,
      md: screenPoints[index].md,
      x: mapped.x,
      y: mapped.y,
      radius: index === 0 ? 10 : 8,
      projected
    });
  }

  if (showLabels) {
    const collar = screenPoints[0].mapped;
    const toe = screenPoints[screenPoints.length - 1].mapped;
    context.fillStyle = COLORS.label;
    context.font = "600 12px Segoe UI Variable, Segoe UI, sans-serif";
    context.fillText(`${borehole.id} Collar`, collar.x + 10, collar.y - 10);
    context.fillText(`Ende ${borehole.totalDepth.toFixed(1)} m`, toe.x + 10, toe.y - 10);
  }

  if (state.hoveredTarget) {
    context.save();
    context.strokeStyle = COLORS.hover;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(state.hoveredTarget.x, state.hoveredTarget.y, state.hoveredTarget.radius + 4, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  drawMeasurement(context, scene, state.measurement);
  drawFrame(context, width, height, padding);
}

function drawGrid(context, width, height) {
  context.save();
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  context.beginPath();

  for (let x = 0; x <= width; x += 50) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }

  for (let y = 0; y <= height; y += 50) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }

  context.stroke();
  context.restore();
}

export function renderCanvas(canvas, state) {
  const context = canvas.getContext("2d");
  const devicePixelRatio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const targetW = Math.round(width * devicePixelRatio);
  const targetH = Math.round(height * devicePixelRatio);

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);

  if (!state.filteredBoreholes.length) {
    context.fillStyle = COLORS.label;
    context.font = "500 14px Segoe UI Variable, Segoe UI, sans-serif";
    context.fillText("Keine Bohrungen für die aktuelle Auswahl.", 24, 40);
    return;
  }

  const padding = 58;
  const selected = state.filteredBoreholes.find((entry) => entry.id === state.selectedId);
  const hitTargets = [];

  if (state.viewMode === "plan") {
    const visibleBoreholes = state.showAll ? state.filteredBoreholes : selected ? [selected] : [];
    if (!visibleBoreholes.length) {
      context.fillStyle = COLORS.label;
      context.font = "500 14px Segoe UI Variable, Segoe UI, sans-serif";
      context.fillText("Bitte eine Bohrung auswaehlen.", 36, 48);
      return { hitTargets, scene: null };
    }
    const projector = createProjector("plan");
    const bounds = getProjectedBounds(visibleBoreholes, projector);
    const scene = createScene(width, height, bounds, padding, state.viewer.camera);
    drawPlanMode(
      context,
      width,
      height,
      padding,
      visibleBoreholes,
      state.selectedId,
      state.showLabels,
      state.showGrid,
      scene,
      state.viewer,
      hitTargets
    );
    return { hitTargets, scene };
  }

  if (!selected) {
    context.fillStyle = COLORS.label;
    context.font = "500 14px Segoe UI Variable, Segoe UI, sans-serif";
    context.fillText("Bitte eine Bohrung auswaehlen.", 36, 48);
    return { hitTargets, scene: null };
  }

  const projector = createProjector(state.viewMode);
  const bounds = getProjectedBounds([selected], projector);
  const scene = createScene(width, height, bounds, padding, state.viewer.camera);
  drawDetailMode(
    context,
    width,
    height,
    padding,
    selected,
    state.viewMode,
    state.showGrid,
    state.showLabels,
    scene,
    state.viewer,
    hitTargets
  );
  return { hitTargets, scene };
}
