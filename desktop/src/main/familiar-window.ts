export interface FamiliarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FamiliarEdge = "left" | "right";

export interface FamiliarSnapResult {
  bounds: FamiliarBounds;
  edge?: FamiliarEdge;
}

export const FAMILIAR_COLLAPSED_SIZE = { width: 252, height: 246 } as const;
export const FAMILIAR_EXPANDED_SIZE = { width: 390, height: 438 } as const;
export const FAMILIAR_EDGE_PEEK = 54;

export function snapFamiliarBounds(
  bounds: FamiliarBounds,
  workArea: FamiliarBounds,
  threshold = 44
): FamiliarSnapResult {
  const minY = workArea.y;
  const maxY = workArea.y + Math.max(0, workArea.height - bounds.height);
  const y = Math.min(Math.max(bounds.y, minY), maxY);
  const leftX = workArea.x;
  const rightX = workArea.x + workArea.width - bounds.width;
  const distanceToLeft = Math.abs(bounds.x - leftX);
  const distanceToRight = Math.abs(bounds.x - rightX);

  if (distanceToLeft <= threshold && distanceToLeft <= distanceToRight) {
    return { bounds: { ...bounds, x: leftX, y }, edge: "left" };
  }
  if (distanceToRight <= threshold) {
    return { bounds: { ...bounds, x: rightX, y }, edge: "right" };
  }
  return {
    bounds: {
      ...bounds,
      x: Math.min(Math.max(bounds.x, leftX), rightX),
      y
    }
  };
}

export function hiddenFamiliarBounds(
  bounds: FamiliarBounds,
  workArea: FamiliarBounds,
  edge: FamiliarEdge,
  peek = FAMILIAR_EDGE_PEEK
): FamiliarBounds {
  return {
    ...bounds,
    x:
      edge === "left"
        ? workArea.x - bounds.width + peek
        : workArea.x + workArea.width - peek,
    y: Math.min(
      Math.max(bounds.y, workArea.y),
      workArea.y + Math.max(0, workArea.height - bounds.height)
    )
  };
}
