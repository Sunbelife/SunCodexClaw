#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoDir = path.resolve(__dirname, '..');
const stageDir = path.join(repoDir, '.runtime', 'remote-cli-package');
const distDir = path.join(repoDir, '.runtime', 'dist');
const rootPackage = require(path.join(repoDir, 'package.json'));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

fs.mkdirSync(stageDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

const cliSourcePath = path.join(repoDir, 'tools', 'scc_cli.js');
const cliSource = fs.readFileSync(cliSourcePath, 'utf8');
const packagedCliSource = cliSource.replace(
  "require('./lib/remote_access')",
  "require('./remote_access')",
);
if (packagedCliSource === cliSource) fail('Unable to rewrite the CLI remote_access import for packaging.');

fs.writeFileSync(path.join(stageDir, 'scc.js'), packagedCliSource, { mode: 0o755 });
fs.copyFileSync(
  path.join(repoDir, 'tools', 'lib', 'remote_access.js'),
  path.join(stageDir, 'remote_access.js'),
);

const cliPackage = {
  name: 'suncodexclaw-cli',
  version: rootPackage.version,
  description: 'Remote multi-machine CLI for SunCodexClaw robots.',
  license: 'UNLICENSED',
  type: 'commonjs',
  bin: { scc: 'scc.js' },
  engines: rootPackage.engines,
  dependencies: { ws: rootPackage.dependencies.ws },
};
fs.writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify(cliPackage, null, 2)}\n`);

const packed = spawnSync('npm', ['pack', '--pack-destination', distDir], {
  cwd: stageDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (packed.status !== 0) fail(`npm pack failed with status ${packed.status}`);

const filename = String(packed.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
if (!filename) fail('npm pack did not return an artifact filename.');
process.stdout.write(`${path.join(distDir, filename)}\n`);
