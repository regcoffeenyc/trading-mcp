import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` is the module Node was started with.
 *
 * The obvious form — `import.meta.url === \`file://${process.argv[1]}\`` —
 * silently fails on Windows, where argv[1] is a backslash path
 * (C:\...\setup.js) and import.meta.url is a file URL
 * (file:///C:/.../setup.js). The comparison never matches, so the CLI body
 * never runs and the process exits 0 having done nothing at all. Comparing
 * resolved filesystem paths works on every platform.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(moduleUrl)) === path.resolve(entry);
  } catch {
    return false;
  }
}
