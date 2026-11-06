/**
 * Project paths with a move or rename in progress. Kept free of imports so the
 * window layer can refuse to open a project mid-move without loading the
 * migration service.
 */
const moving = new Set<string>();

export function markProjectMoving(projectPath: string): void {
  moving.add(projectPath);
}

export function clearProjectMoving(projectPath: string): void {
  moving.delete(projectPath);
}

export function isProjectMoving(projectPath: string): boolean {
  return moving.has(projectPath);
}
