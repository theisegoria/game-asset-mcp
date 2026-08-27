import { rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = path.join(repository, 'dist');
const relative = path.relative(repository, distribution);

if (relative !== 'dist' || path.dirname(distribution) !== repository) {
  throw new Error(`refusing to clean unexpected distribution path: ${distribution}`);
}

// Resolve the repository itself so a symlinked checkout cannot make the
// lexical guard above describe a different tree than the one being built.
const realRepository = await realpath(repository);
if (path.dirname(path.join(realRepository, 'dist')) !== realRepository) {
  throw new Error('refusing to clean a distribution path outside the repository');
}

await rm(distribution, { recursive: true, force: true });
