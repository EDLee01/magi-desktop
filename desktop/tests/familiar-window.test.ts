import { describe, expect, it } from "vitest";

import {
  hiddenFamiliarBounds,
  snapFamiliarBounds
} from "../src/main/familiar-window.js";

const workArea = { x: 0, y: 24, width: 1440, height: 876 };
const pet = { x: 10, y: 100, width: 252, height: 246 };

describe("Magi Familiar window placement", () => {
  it("snaps near the left or right screen edge", () => {
    expect(snapFamiliarBounds(pet, workArea)).toMatchObject({
      edge: "left",
      bounds: { x: 0, y: 100 }
    });
    expect(
      snapFamiliarBounds({ ...pet, x: 1440 - 252 - 12 }, workArea)
    ).toMatchObject({ edge: "right", bounds: { x: 1188, y: 100 } });
  });

  it("keeps a freely placed familiar inside the work area", () => {
    expect(snapFamiliarBounds({ ...pet, x: 500, y: -100 }, workArea)).toEqual({
      bounds: { ...pet, x: 500, y: 24 }
    });
  });

  it("leaves a small visible peek when hiding at either edge", () => {
    expect(hiddenFamiliarBounds({ ...pet, x: 0 }, workArea, "left", 54).x).toBe(-198);
    expect(hiddenFamiliarBounds({ ...pet, x: 1188 }, workArea, "right", 54).x).toBe(1386);
  });
});
