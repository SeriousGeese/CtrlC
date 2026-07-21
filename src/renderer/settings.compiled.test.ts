// @vitest-environment node
//
// The Settings renderer is an inline classic script. A duplicate top-level
// lexical declaration prevents the entire script from parsing, so no settings
// values are loaded or saved. Parse the built script directly to catch this.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { execSync } from 'node:child_process';

const projectRoot = process.cwd();
const compiledSettings = path.join(projectRoot, 'dist', 'renderer', 'settings.html');

beforeAll(() => {
  if (!fs.existsSync(compiledSettings)) {
    execSync('npm run build', { cwd: projectRoot, stdio: 'ignore' });
  }
});

describe('compiled settings.html inline script', () => {
  it('parses without duplicate lexical declarations', () => {
    const html = fs.readFileSync(compiledSettings, 'utf-8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new vm.Script(script!)).not.toThrow();
  });
});
