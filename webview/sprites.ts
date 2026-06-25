/**
 * Sprite sheet configuration for the CodeCubicle webview.
 *
 * Character sprites from "Modern tiles_Free" pack (LimeZu):
 *   - Each frame is 16 wide × 32 tall (verified via pixel inspection).
 *   - idle/run/sit sheets: 384×32 = 24 columns × 1 row
 *   - phone sheet: 144×32 = 9 columns × 1 row
 *
 * The 24-frame sheets are 4 directions × 6 frames (verified by extracting
 * frames — the FRONT/camera-facing block is cols 18–23, NOT 0–5):
 *   Columns 0–5:   side/down
 *   Columns 6–11:  back (only hair visible)
 *   Columns 12–17: other side
 *   Columns 18–23: front (eyes facing camera) ← what we use
 *
 * The `phone` sheet (9 frames) is entirely front-facing, so it uses col 0.
 *
 * NOTE: the `sit` sheets only contain SIDE-facing poses (no front view),
 * so they are not used — desks face the camera. Front-facing states are
 * built from idle / run / phone sheets plus on-screen activity indicators.
 *
 * The character art occupies roughly y[9–31] within each 16×32 frame
 * (head near the middle, feet at the bottom).
 */

export const TILE = 16;
export const CHAR_W = 16;
export const CHAR_H = 32;

// --- Character sprite sheets ---

export interface AnimationDef {
  /** Sprite sheet filename (relative to sprites/ dir) */
  sheet: string;
  /** Start frame column index */
  startFrame: number;
  /** Number of frames in this animation loop */
  frameCount: number;
}

export interface CharacterDef {
  name: string;
  animations: Record<string, AnimationDef>;
}

function makeCharacterDef(prefix: string, displayName: string): CharacterDef {
  return {
    name: displayName,
    animations: {
      // Front-facing idle loop (cols 18–23)
      idle: { sheet: `${prefix}_idle.png`, startFrame: 18, frameCount: 6 },
      // Typing — idle base pose + on-screen typing indicator (sit has no front view)
      typing: { sheet: `${prefix}_idle.png`, startFrame: 18, frameCount: 6 },
      // Running / walking (front-facing, cols 18–23)
      walking: { sheet: `${prefix}_run.png`, startFrame: 18, frameCount: 6 },
      // Side-facing walk cycles for entering/leaving the office.
      // Cols 0–5 and 12–17 are the two side views. If a character walks the
      // wrong way visually, swap these two startFrame values.
      walkLeft: { sheet: `${prefix}_run.png`, startFrame: 12, frameCount: 6 },
      walkRight: { sheet: `${prefix}_run.png`, startFrame: 0, frameCount: 6 },
      // On the phone — full 9-frame front-facing loop
      thinking: { sheet: `${prefix}_phone.png`, startFrame: 0, frameCount: 9 },
      talking: { sheet: `${prefix}_phone.png`, startFrame: 0, frameCount: 9 },
      // Celebrate with the run animation (energetic, front-facing)
      celebrating: { sheet: `${prefix}_run.png`, startFrame: 18, frameCount: 6 },
    },
  };
}

/** Available character sprite definitions */
export const CHARACTERS: CharacterDef[] = [
  makeCharacterDef("adam", "Adam"),
  makeCharacterDef("alex", "Alex"),
  makeCharacterDef("amelia", "Amelia"),
  makeCharacterDef("bob", "Bob"),
];

// --- Interior object sprites (from the "Modern tiles_Free" interiors atlas) ---

/** A sub-rectangle within a sprite sheet (source pixels). */
export interface SpriteRect {
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const INTERIOR_SHEET = "interiors.png";

/**
 * Named object cut-outs from `interiors.png`, measured (alpha bounding box) by
 * frame extraction. Drawn at native size for crispness.
 */
export const INTERIORS: Record<string, SpriteRect> = {
  window: { sheet: INTERIOR_SHEET, x: 212, y: 366, w: 24, h: 18 },
  chair: { sheet: INTERIOR_SHEET, x: 146, y: 497, w: 13, h: 21 },
  palm: { sheet: INTERIOR_SHEET, x: 213, y: 704, w: 23, h: 31 },
  plant: { sheet: INTERIOR_SHEET, x: 167, y: 713, w: 18, h: 23 },
  succulent: { sheet: INTERIOR_SHEET, x: 2, y: 790, w: 12, h: 14 },
};

