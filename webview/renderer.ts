/**
 * CodeCubicle webview renderer.
 * Draws a tiny pixel art office with animated workers on an HTML Canvas.
 * Uses sprite sheets from the "Modern tiles_Free" pack for character animations.
 * Communicates with the extension host via postMessage.
 */

import {
  TILE,
  CHAR_W,
  CHAR_H,
  CHARACTERS,
  INTERIORS,
  INTERIOR_SHEET,
  type AnimationDef,
  type CharacterDef,
} from "./sprites";

// Types duplicated here to avoid cross-context imports.
// Keep in sync with src/types.ts.
type AgentRole = "main" | "subagent";
type WorkerAnimation = "idle" | "typing" | "thinking" | "talking" | "walking" | "celebrating";
type ActivityKind = "edit" | "read" | "search" | "shell" | "web" | "think";

interface WorkerState {
  id: string;
  name: string;
  role: AgentRole;
  animation: WorkerAnimation;
  activity?: ActivityKind;
  station: number;
}

/**
 * Renderer-side view of a worker. Wraps the synced WorkerState with transient
 * animation state so workers can walk in from the door and walk back out when
 * they leave, rather than popping in/out instantly.
 */
interface RenderWorker {
  worker: WorkerState;
  station: number;
  /** Current logical x of the worker's feet (animated). */
  x: number;
  /** Off-screen x this worker enters from / exits to (left or right door). */
  doorX: number;
  phase: "entering" | "present" | "leaving";
}

type ExtToWebMessage =
  | { type: "agent-update"; payload: unknown }
  | { type: "state-sync"; payload: WorkerState[] }
  | { type: "reset" };

// --- Canvas setup ---

const canvas = document.getElementById("office") as HTMLCanvasElement;
const ctx2d = canvas.getContext("2d");
if (!ctx2d) {
  throw new Error("CodeCubicle: 2D canvas context unavailable");
}
// `ctx2d` is narrowed to non-null here, so `ctx` carries a non-null type
// into every drawing function below (no `!` assertions needed).
const ctx = ctx2d;

// Logical office dimensions: 16 tiles wide × 10 tiles tall (256×160).
// All drawing uses these logical coordinates.
const OFFICE_WIDTH = 16;
const OFFICE_HEIGHT = 10;
const LOGICAL_W = OFFICE_WIDTH * TILE;
const LOGICAL_H = OFFICE_HEIGHT * TILE;

// Render scale: the canvas backing store is SCALE× the logical size so that
// text and vector icons rasterize at high resolution, while pixel-art sprites
// are upscaled with nearest-neighbor (imageSmoothingEnabled=false) to stay crisp.
const SCALE = 4;
canvas.width = LOGICAL_W * SCALE;
canvas.height = LOGICAL_H * SCALE;

const TARGET_FPS = 8;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

let frameCount = 0;
let lastFrameTime = 0;

/** Animated view of the office, keyed by station. */
const renderWorkers: Map<number, RenderWorker> = new Map();

// --- VS Code API ---

// @ts-expect-error acquireVsCodeApi is injected by VS Code webview
const vscode = acquireVsCodeApi();

// --- Colors ---

const COLORS = {
  // Walls
  wall: "#6d6a8a",
  wallLight: "#7c79a0",
  wallShadow: "#565274",
  baseboard: "#4a4660",
  // Floor
  floor: "#caa472",
  floorAlt: "#bd9866",
  floorLine: "#a07d52",
  rug: "#3b6ea5",
  rugBorder: "#2c5380",
  rugInner: "#4a82bd",
  // Furniture
  deskTop: "#9a7b4f",
  deskTopLight: "#b08f5e",
  deskEdge: "#6e5435",
  deskLeg: "#5a4530",
  monitor: "#15151f",
  monitorTrim: "#2a2a3a",
  screenOn: "#1e293b",
  screenCode1: "#4ade80",
  screenCode2: "#60a5fa",
  screenCode3: "#fbbf24",
  chair: "#3a4a6a",
  chairDark: "#2c3a55",
  // Plants
  plantPot: "#b06a3a",
  plantPotDark: "#8a5028",
  plantLeaf: "#3da35a",
  plantLeafLight: "#52c46f",
  // Decor
  window: "#aee3f0",
  windowSky: "#7cc7e8",
  windowFrame: "#e8e8f0",
  clockFace: "#f5f5f0",
  clockFrame: "#2a2a3a",
  whiteboard: "#f0f0e8",
  // Text/UI
  text: "#ffffff",
  textDim: "#cdd3e0",
  pill: "#1a1a2e",
  badgeMain: "#3b82f6",
  badgeSub: "#ec4899",
  bubble: "#ffffff",
  bubbleText: "#1a1a2e",
  bubbleOutline: "#1a1a2e",
} as const;

// --- Sprite loading ---

const spriteCache: Map<string, HTMLImageElement> = new Map();
let spritesLoaded = false;
let spritesToLoad = 0;
let spritesLoadedCount = 0;

/** Framed wall logo (vector). Aspect from the source SVG's viewBox. */
const LOGO_SHEET = "ving.svg";
const LOGO_ASPECT = 185.20763 / 69.820686;

function getSpriteBaseUri(): string {
  return document.body.dataset.spriteUri || "./sprites";
}

function loadSprite(filename: string): HTMLImageElement {
  const cached = spriteCache.get(filename);
  if (cached) return cached;

  const img = new Image();
  img.src = `${getSpriteBaseUri()}/${filename}`;
  spritesToLoad++;
  img.onload = (): void => {
    spritesLoadedCount++;
    if (spritesLoadedCount >= spritesToLoad) {
      spritesLoaded = true;
    }
  };
  img.onerror = (): void => {
    console.warn(`[CodeCubicle] Failed to load sprite: ${filename}`);
    spritesLoadedCount++;
    if (spritesLoadedCount >= spritesToLoad) {
      spritesLoaded = true;
    }
  };
  spriteCache.set(filename, img);
  return img;
}

function preloadSprites(): void {
  // Character animation sheets...
  for (const char of CHARACTERS) {
    for (const anim of Object.values(char.animations)) {
      loadSprite(anim.sheet);
    }
  }
  // ...plus the interiors atlas (windows, chairs, plants).
  loadSprite(INTERIOR_SHEET);
  // ...and the wall logo poster.
  loadSprite(LOGO_SHEET);
}

/** Blit a named interior object cut-out at native size, top-left anchored. */
function drawInterior(name: keyof typeof INTERIORS, destX: number, destY: number): void {
  const rect = INTERIORS[name];
  const img = spriteCache.get(rect.sheet);
  if (!img || !img.complete || img.naturalWidth === 0) return;
  ctx.drawImage(
    img,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    Math.round(destX),
    Math.round(destY),
    rect.w,
    rect.h
  );
}

/** Blit a named interior object anchored by its bottom-center (cx, baseY). */
function drawInteriorBottom(name: keyof typeof INTERIORS, cx: number, baseY: number): void {
  const rect = INTERIORS[name];
  drawInterior(name, cx - rect.w / 2, baseY - rect.h);
}

/** Draw the framed vector logo poster on the wall, top-left anchored. */
function drawLogoPoster(x: number, y: number, w: number): void {
  const img = spriteCache.get(LOGO_SHEET);
  if (!img || !img.complete || img.naturalWidth === 0) return;
  const h = Math.round(w / LOGO_ASPECT);
  // Outer frame + cream mat behind the logo
  ctx.fillStyle = "#2c2a3e";
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = "#f4f1e8";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  // The SVG is a smooth vector — render it with smoothing on so it stays clean
  // when scaled down, then restore nearest-neighbor for the pixel art.
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, x, y, w, h);
  ctx.imageSmoothingEnabled = false;
}

// --- Drawing helpers ---

/** Draw crisp text with a tight dark outline for readability */
function drawTextOutlined(
  text: string,
  x: number,
  y: number,
  color: string,
  font = "6px monospace"
): void {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // Tight outline (0.5 logical px) — high-res backing keeps it sharp
  const o = 0.5;
  ctx.fillStyle = "rgba(0,0,0,0.9)";
  ctx.fillText(text, x - o, y);
  ctx.fillText(text, x + o, y);
  ctx.fillText(text, x, y - o);
  ctx.fillText(text, x, y + o);
  ctx.fillText(text, x - o, y - o);
  ctx.fillText(text, x + o, y + o);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// --- Office background (programmatic) ---

function drawWall(): void {
  // Base wall with vertical gradient feel (two bands)
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(0, 0, LOGICAL_W, 3 * TILE);
  ctx.fillStyle = COLORS.wallLight;
  ctx.fillRect(0, 0, LOGICAL_W, TILE);

  // Subtle vertical panel seams
  ctx.fillStyle = COLORS.wallShadow;
  for (let x = TILE * 2; x < LOGICAL_W; x += TILE * 2) {
    ctx.fillRect(x, 0, 1, 3 * TILE - 2);
  }

  // Baseboard
  ctx.fillStyle = COLORS.baseboard;
  ctx.fillRect(0, 3 * TILE - 3, LOGICAL_W, 3);
}

function drawWindow(x: number, y: number): void {
  // Frame
  ctx.fillStyle = COLORS.windowFrame;
  ctx.fillRect(x - 1, y - 1, 34, 26);
  // Sky
  ctx.fillStyle = COLORS.windowSky;
  ctx.fillRect(x, y, 32, 24);
  // Lighter top sky band
  ctx.fillStyle = COLORS.window;
  ctx.fillRect(x, y, 32, 10);
  // Sun
  ctx.fillStyle = "#ffe9a8";
  ctx.fillRect(x + 23, y + 3, 5, 5);
  // Clouds
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + 4, y + 6, 8, 3);
  ctx.fillRect(x + 6, y + 4, 4, 2);
  ctx.fillRect(x + 14, y + 14, 7, 3);
  // Mullions
  ctx.fillStyle = COLORS.windowFrame;
  ctx.fillRect(x + 15, y, 2, 24);
  ctx.fillRect(x, y + 11, 32, 2);
}

function drawClock(cx: number, cy: number): void {
  // Frame
  ctx.fillStyle = COLORS.clockFrame;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
  // Face
  ctx.fillStyle = COLORS.clockFace;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  // Hands (animate slowly)
  const t = frameCount * 0.05;
  ctx.strokeStyle = COLORS.clockFrame;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Hour hand: short + slow
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(t * 0.5) * 3, cy + Math.sin(t * 0.5) * 3);
  // Minute hand: long + fast
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(t) * 4, cy + Math.sin(t) * 4);
  ctx.stroke();
}

function drawWhiteboard(x: number, y: number): void {
  // Frame
  ctx.fillStyle = "#b8b8c8";
  ctx.fillRect(x - 1, y - 1, 36, 22);
  // Board
  ctx.fillStyle = COLORS.whiteboard;
  ctx.fillRect(x, y, 34, 20);
  // Scribbles
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(x + 3, y + 4, 14, 1);
  ctx.fillRect(x + 3, y + 7, 20, 1);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(x + 3, y + 11, 10, 1);
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(x + 3, y + 14, 16, 1);
  // A little chart box
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 24, y + 10, 7, 6);
}

function drawWallDecor(): void {
  const LOGO_W = 46;
  const logoX = Math.round((LOGICAL_W - LOGO_W) / 2); // centered on the wall
  drawWindow(TILE + 2, 8);
  drawLogoPoster(logoX, 11, LOGO_W);
  drawWhiteboard(LOGICAL_W - TILE * 4 - 2, 10);
  // Clock sits between the window and the centered logo poster.
  drawClock((TILE + 2 + 32 + logoX) / 2, 18);
}

function drawFloor(): void {
  const top = 3 * TILE;
  // Wood planks (horizontal rows, brick-offset seams)
  for (let row = 0; top + row * TILE < LOGICAL_H; row++) {
    const y = top + row * TILE;
    ctx.fillStyle = row % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
    ctx.fillRect(0, y, LOGICAL_W, TILE);
    // Plank seam line
    ctx.fillStyle = COLORS.floorLine;
    ctx.fillRect(0, y, LOGICAL_W, 1);
    // Vertical plank breaks (offset per row)
    const offset = (row % 2) * TILE * 2;
    for (let x = offset; x < LOGICAL_W; x += TILE * 4) {
      ctx.fillRect(x, y, 1, TILE);
    }
  }

  // Central rug under the workers
  const rugX = TILE;
  const rugY = WORKER_BASELINE - 6;
  const rugW = LOGICAL_W - TILE * 2;
  const rugH = 22;
  ctx.fillStyle = COLORS.rugBorder;
  ctx.fillRect(rugX, rugY, rugW, rugH);
  ctx.fillStyle = COLORS.rug;
  ctx.fillRect(rugX + 2, rugY + 2, rugW - 4, rugH - 4);
  ctx.fillStyle = COLORS.rugInner;
  ctx.fillRect(rugX + 5, rugY + 5, rugW - 10, rugH - 10);
}

// --- Office furniture (programmatic) ---

function drawDesk(x: number, y: number): void {
  // Top surface
  ctx.fillStyle = COLORS.deskTop;
  ctx.fillRect(x, y, TILE * 2, TILE - 4);
  ctx.fillStyle = COLORS.deskTopLight;
  ctx.fillRect(x, y, TILE * 2, 2);
  // Front edge
  ctx.fillStyle = COLORS.deskEdge;
  ctx.fillRect(x, y + TILE - 4, TILE * 2, 4);
  // Legs
  ctx.fillStyle = COLORS.deskLeg;
  ctx.fillRect(x + 2, y + TILE, 3, TILE - 6);
  ctx.fillRect(x + TILE * 2 - 5, y + TILE, 3, TILE - 6);
  // Keyboard on desk (toward the front edge)
  ctx.fillStyle = "#cfd3dc";
  ctx.fillRect(x + 9, y + 6, 14, 4);
  ctx.fillStyle = "#9aa0ad";
  ctx.fillRect(x + 9, y + 6, 14, 1);
  // Coffee mug
  ctx.fillStyle = "#e85d4e";
  ctx.fillRect(x + 2, y + 1, 4, 4);
  ctx.fillStyle = "#c4453a";
  ctx.fillRect(x + 6, y + 2, 1, 2);
}

function drawMonitor(x: number, y: number, active: boolean): void {
  // Bezel
  ctx.fillStyle = COLORS.monitor;
  ctx.fillRect(x, y, 14, 11);
  ctx.fillStyle = COLORS.monitorTrim;
  ctx.fillRect(x, y, 14, 1);
  // Screen
  ctx.fillStyle = COLORS.screenOn;
  ctx.fillRect(x + 1, y + 1, 12, 9);

  if (active) {
    // Scrolling "code" lines
    const palette = [COLORS.screenCode1, COLORS.screenCode2, COLORS.screenCode3];
    for (let i = 0; i < 4; i++) {
      const lineY = y + 2 + i * 2;
      const seed = (i + frameCount) % 5;
      const lineW = 3 + ((seed * 3) % 8);
      ctx.fillStyle = palette[(i + Math.floor(frameCount / 2)) % palette.length];
      ctx.fillRect(x + 2, lineY, lineW, 1);
    }
  } else {
    ctx.fillStyle = "#2a2a3e";
    ctx.fillRect(x + 1, y + 1, 12, 9);
  }

  // Stand
  ctx.fillStyle = COLORS.monitor;
  ctx.fillRect(x + 5, y + 11, 4, 2);
  ctx.fillRect(x + 3, y + 13, 8, 2);
}

/** Workstation X positions (tile units) for up to 4 workers */
const STATION_X = [1, 5, 9, 13];
const DESK_ROW = 3; // tile row for desk tops (close to the wall)
const WORKER_BASELINE = 7 * TILE; // y where worker feet rest (in front of desks)

/** Where workers enter from / exit to. Stations 0–1 use the left door, 2–3 the right. */
const DOOR_LEFT_X = -CHAR_W;
const DOOR_RIGHT_X = LOGICAL_W;
/** How fast workers walk in/out, in logical px per rendered frame. */
const WALK_SPEED = 4;

/** The off-screen door x a given station enters from / exits to. */
function doorXFor(station: number): number {
  return station <= 1 ? DOOR_LEFT_X : DOOR_RIGHT_X;
}

/** Map a workstation index to the worker's on-screen feet position. */
function stationToPos(station: number): { x: number; y: number } {
  const col = STATION_X[station % STATION_X.length];
  // +8 centers the 16px sprite under the 32px desk
  return { x: col * TILE + 8, y: WORKER_BASELINE };
}

function drawOfficeFurniture(): void {
  const DESK_Y = DESK_ROW * TILE;
  // Chairs tuck in just below each desk; plants sit a little above the rug.
  const CHAIR_Y = DESK_Y + TILE * 2;
  const PLANT_Y = WORKER_BASELINE - TILE;

  // 4 workstations evenly spaced. Draw the desk first, then the monitor resting
  // on its surface and the chair tucked in front — both on top of the desk.
  for (let i = 0; i < 4; i++) {
    const stationX = STATION_X[i] * TILE;
    const deskCenterX = stationX + TILE;
    drawDesk(stationX, DESK_Y);
    drawMonitor(stationX + 9, DESK_Y - 9, true);
    drawInteriorBottom("chair", deskCenterX, CHAIR_Y);
  }

  // Potted plants flanking the room (tree on the left, palm on the right).
  drawInteriorBottom("plant", 11, PLANT_Y);
  drawInteriorBottom("palm", LOGICAL_W - 13, PLANT_Y);
}

// --- Character sprite drawing ---

function getCharacterForWorker(workerIndex: number): CharacterDef {
  return CHARACTERS[workerIndex % CHARACTERS.length];
}

function drawCharacterSprite(animDef: AnimationDef, destX: number, destY: number): void {
  const img = spriteCache.get(animDef.sheet);
  if (!img || !img.complete || img.naturalWidth === 0) return;

  // Frames are 16 wide × 32 tall, laid out in a single row
  const currentFrame = animDef.startFrame + (frameCount % animDef.frameCount);
  const srcX = currentFrame * CHAR_W;
  const srcY = 0;

  // Draw anchored so the character's feet sit at destY (destY = baseline)
  ctx.drawImage(
    img,
    srcX,
    srcY,
    CHAR_W,
    CHAR_H,
    destX,
    destY - CHAR_H,
    CHAR_W,
    CHAR_H
  );
}

function drawWorker(rw: RenderWorker): void {
  const { worker, x, phase } = rw;
  const character = getCharacterForWorker(worker.station);
  const y = WORKER_BASELINE;

  // Pick the animation: side-facing walk while entering/leaving (facing the
  // direction of travel, which depends on the worker's door side), otherwise
  // the worker's current activity animation.
  const deskX = stationToPos(worker.station).x;
  let animDef: AnimationDef;
  if (phase === "entering") {
    animDef = deskX >= rw.doorX ? character.animations.walkRight : character.animations.walkLeft;
  } else if (phase === "leaving") {
    animDef = rw.doorX >= deskX ? character.animations.walkRight : character.animations.walkLeft;
  } else {
    animDef = character.animations[worker.animation] ?? character.animations.idle;
  }

  // Soft shadow under the worker
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(x + CHAR_W / 2, y - 1, 6, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  if (spritesLoaded) {
    drawCharacterSprite(animDef, x, y);
  } else {
    ctx.fillStyle = worker.role === "main" ? "#60a5fa" : "#f472b6";
    ctx.fillRect(x - 4, y - 18, 8, 14);
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(x - 3, y - 24, 6, 6);
  }

  // Activity bubble only while seated at the desk (not mid-walk).
  if (phase === "present") {
    drawActivityBubble(worker, x + CHAR_W / 2, y - CHAR_H - 2);
  }

  // Name pill below feet — show the character's personal name (tied to the
  // station/sprite) rather than the parser's role name, so each desk is a
  // distinct, consistent person (Adam/Alex/Amelia/Bob).
  drawNamePill(worker, character.name, x + CHAR_W / 2, y + 9);
}

/** Small speech bubble showing what the worker is doing */
function drawActivityBubble(worker: WorkerState, cx: number, cy: number): void {
  const float = Math.sin((frameCount + worker.station * 7) * 0.2) * 1;
  const by = cy + float;

  // Bubble body
  const w = 16;
  const h = 11;
  const o = 1; // outline thickness (logical px)
  const bx = cx - w / 2;
  const bTop = by - h;
  // Outline: draw a slightly larger dark shape behind body + tail
  ctx.fillStyle = COLORS.bubbleOutline;
  ctx.fillRect(bx - o, bTop - o, w + o * 2, h + o * 2);
  ctx.fillRect(cx - 1 - o, by - o, 3 + o * 2, 2 + o * 2);
  // Body
  ctx.fillStyle = COLORS.bubble;
  ctx.fillRect(bx, bTop, w, h);
  // Little tail
  ctx.fillRect(cx - 1, by, 3, 2);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const iconY = by - h / 2;

  // Lifecycle poses keep an animation-driven icon — they override the activity.
  if (worker.animation === "walking") {
    // Gear-ish dots (busy / walking in)
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(cx - 3, iconY - 3, 2, 2);
    ctx.fillRect(cx + 1, iconY - 3, 2, 2);
    ctx.fillRect(cx - 1, iconY, 2, 2);
    return;
  }
  if (worker.animation === "celebrating") {
    // Checkmark
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(cx - 3, iconY, 2, 2);
    ctx.fillRect(cx - 1, iconY + 2, 2, 2);
    ctx.fillRect(cx + 1, iconY - 2, 2, 2);
    ctx.fillRect(cx + 3, iconY - 4, 2, 2);
    return;
  }
  if (worker.animation === "idle") {
    drawTextOutlined("Zzz", cx, iconY + 3, "#94a3b8", "7px monospace");
    return;
  }

  // Active (typing/thinking/talking): show WHAT the worker is doing. Falls back
  // to an animation-based icon when the activity kind is unknown.
  switch (worker.activity) {
    case "edit": {
      // Pencil: dark tip (bottom-left) → orange body diagonal up-right
      ctx.fillStyle = "#475569";
      ctx.fillRect(cx - 4, iconY + 2, 2, 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(cx - 2, iconY, 2, 2);
      ctx.fillRect(cx, iconY - 2, 2, 2);
      ctx.fillRect(cx + 2, iconY - 4, 2, 2);
      return;
    }
    case "read": {
      // Lines of text on a page
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(cx - 4, iconY - 3, 8, 1);
      ctx.fillStyle = "#64748b";
      ctx.fillRect(cx - 4, iconY - 1, 8, 1);
      ctx.fillRect(cx - 4, iconY + 1, 8, 1);
      ctx.fillRect(cx - 4, iconY + 3, 5, 1);
      return;
    }
    case "search": {
      // Magnifying glass: hollow ring + handle
      ctx.fillStyle = "#0ea5e9";
      ctx.fillRect(cx - 4, iconY - 4, 5, 1);
      ctx.fillRect(cx - 4, iconY, 5, 1);
      ctx.fillRect(cx - 4, iconY - 3, 1, 3);
      ctx.fillRect(cx, iconY - 3, 1, 3);
      ctx.fillRect(cx + 1, iconY + 1, 2, 2);
      ctx.fillRect(cx + 3, iconY + 3, 2, 2);
      return;
    }
    case "shell": {
      // Terminal prompt
      drawTextOutlined(">_", cx, iconY + 3, "#22c55e", "8px monospace");
      return;
    }
    case "web": {
      // Globe: ring + equator + meridian
      ctx.fillStyle = "#10b981";
      ctx.fillRect(cx - 3, iconY - 3, 6, 1);
      ctx.fillRect(cx - 3, iconY + 2, 6, 1);
      ctx.fillRect(cx - 3, iconY - 2, 1, 4);
      ctx.fillRect(cx + 2, iconY - 2, 1, 4);
      ctx.fillRect(cx - 3, iconY, 6, 1);
      ctx.fillRect(cx - 1, iconY - 2, 1, 4);
      return;
    }
    case "think": {
      // Lightbulb
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(cx - 2, by - h + 2, 4, 4);
      ctx.fillStyle = "#92600a";
      ctx.fillRect(cx - 1, by - h + 6, 2, 2);
      return;
    }
    default: {
      if (worker.animation === "typing") {
        // Animated typing dots
        const dots = (Math.floor(frameCount / 2) % 3) + 1;
        for (let d = 0; d < 3; d++) {
          ctx.fillStyle = d < dots ? "#3b82f6" : "#c7d2e8";
          ctx.fillRect(cx - 5 + d * 4, iconY - 1, 2, 2);
        }
        return;
      }
      // Lightbulb (generic thinking)
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(cx - 2, by - h + 2, 4, 4);
      ctx.fillStyle = "#92600a";
      ctx.fillRect(cx - 1, by - h + 6, 2, 2);
    }
  }
}

/** Name label with rounded dark pill + role badge */
function drawNamePill(
  worker: WorkerState,
  displayName: string,
  cx: number,
  baselineY: number
): void {
  const label = displayName.slice(0, 10);
  ctx.font = "6px monospace";
  const textW = ctx.measureText(label).width;
  const padX = 3;
  const pillW = Math.ceil(textW) + padX * 2 + 6; // +6 for badge dot
  const pillH = 9;
  const pillX = cx - pillW / 2;
  const pillY = baselineY - pillH + 2;

  // Pill background
  ctx.fillStyle = COLORS.pill;
  ctx.fillRect(pillX, pillY, pillW, pillH);
  ctx.fillStyle = worker.role === "main" ? COLORS.badgeMain : COLORS.badgeSub;
  ctx.fillRect(pillX, pillY, 2, pillH); // colored left edge

  // Role badge dot
  ctx.fillStyle = worker.role === "main" ? COLORS.badgeMain : COLORS.badgeSub;
  ctx.beginPath();
  ctx.arc(pillX + 6, pillY + pillH / 2, 2, 0, Math.PI * 2);
  ctx.fill();

  // Name text
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, pillX + padX + 6, baselineY);
}

// --- Worker reconciliation (walk in / walk out) ---

/**
 * Reconcile the animated office against a freshly synced worker list.
 * New workers start walking in from the door; workers no longer present start
 * walking out. Workers are keyed by station (a stable, unique person/desk).
 */
function syncWorkers(list: WorkerState[]): void {
  const present = new Set<number>();
  for (const w of list) {
    present.add(w.station);
    const existing = renderWorkers.get(w.station);
    if (existing) {
      existing.worker = w;
      // If they were on their way out but got reactivated, walk back in.
      if (existing.phase === "leaving") existing.phase = "entering";
    } else {
      const doorX = doorXFor(w.station);
      renderWorkers.set(w.station, {
        worker: w,
        station: w.station,
        x: doorX,
        doorX,
        phase: "entering",
      });
    }
  }
  // Anyone missing from the new list heads for the door.
  for (const rw of renderWorkers.values()) {
    if (!present.has(rw.station) && rw.phase !== "leaving") {
      rw.phase = "leaving";
    }
  }
}

/** Advance one walk step; returns false if the worker has fully exited. */
function advanceWorker(rw: RenderWorker): boolean {
  const deskX = stationToPos(rw.station).x;
  if (rw.phase === "entering") {
    // Walk from the door toward the desk (either direction).
    if (rw.x < deskX) rw.x = Math.min(deskX, rw.x + WALK_SPEED);
    else if (rw.x > deskX) rw.x = Math.max(deskX, rw.x - WALK_SPEED);
    if (rw.x === deskX) rw.phase = "present";
  } else if (rw.phase === "leaving") {
    // Walk from the desk back to the door (either direction).
    if (rw.x > rw.doorX) rw.x = Math.max(rw.doorX, rw.x - WALK_SPEED);
    else rw.x = Math.min(rw.doorX, rw.x + WALK_SPEED);
    if (rw.x === rw.doorX) return false;
  } else {
    rw.x = deskX;
  }
  return true;
}

// --- Render loop ---

function render(timestamp: number): void {
  if (timestamp - lastFrameTime < FRAME_INTERVAL) {
    requestAnimationFrame(render);
    return;
  }
  lastFrameTime = timestamp;
  frameCount++;

  // High-res backing store + scale transform: pixel art stays crisp via
  // nearest-neighbor, text/icons rasterize smoothly at full resolution.
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  // Draw background
  drawWall();
  drawWallDecor();
  drawFloor();
  drawOfficeFurniture();

  // Draw workers: advance each walk step, drop any that have fully exited.
  for (const rw of [...renderWorkers.values()]) {
    if (!advanceWorker(rw)) {
      renderWorkers.delete(rw.station);
      continue;
    }
    drawWorker(rw);
  }

  // Status banner — shown only when the office is empty.
  if (renderWorkers.size === 0) {
    const msg = "Waiting for agent activity...";
    ctx.font = "7px monospace";
    const w = ctx.measureText(msg).width + 12;
    const bx = (LOGICAL_W - w) / 2;
    const by = LOGICAL_H - 14;
    ctx.fillStyle = "rgba(26,26,46,0.85)";
    ctx.fillRect(bx, by, w, 11);
    drawTextOutlined(msg, LOGICAL_W / 2, by + 8, COLORS.textDim, "7px monospace");
  }

  requestAnimationFrame(render);
}

// --- Message handling ---

window.addEventListener("message", (event) => {
  const msg = event.data as ExtToWebMessage;
  switch (msg.type) {
    case "state-sync":
      syncWorkers(msg.payload);
      break;
    case "reset":
      // Send everyone walking out rather than clearing instantly.
      for (const rw of renderWorkers.values()) rw.phase = "leaving";
      break;
  }
});

// --- Init ---

preloadSprites();
vscode.postMessage({ type: "ready" });
requestAnimationFrame(render);
