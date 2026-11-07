import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDirectory = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = join(apiDirectory, 'dist');
const output = lstatSync(outputDirectory, { throwIfNoEntry: false });

if (output && (!output.isDirectory() || output.isSymbolicLink())) {
  throw new Error('Refusing to clean dist: expected a generated output directory, not a file or link.');
}

// Only remove generated output at this API's fixed dist path.
rmSync(outputDirectory, { recursive: true, force: true });
