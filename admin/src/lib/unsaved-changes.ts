export function shouldBlockNavigation(
  dirty: boolean,
  currentPath: string,
  nextPath: string,
  bypass: boolean,
): boolean {
  return dirty && currentPath !== nextPath && !bypass;
}
