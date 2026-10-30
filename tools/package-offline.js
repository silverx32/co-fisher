'use strict';
// Run after npm run release to include the verified Microsoft offline runtime installer.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'redistributables', 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
if (!fs.existsSync(installer) || fs.statSync(installer).size < 50 * 1024 * 1024) {
  throw new Error('Missing full WebView2 x64 offline installer in redistributables/');
}
const appDir = path.join(root, 'dist', 'CoFisher');
for (const name of ['CoFisher.exe', 'steam_api64.dll', 'steam_appid.txt']) {
  if (!fs.existsSync(path.join(appDir, name))) throw new Error(`Missing release file: ${name}`);
}
fs.mkdirSync(path.join(appDir, 'dependencies'), { recursive: true });
fs.copyFileSync(installer, path.join(appDir, 'dependencies', path.basename(installer)));
fs.copyFileSync(path.join(root, 'docs', '离线包说明.txt'), path.join(appDir, '离线包说明.txt'));
execFileSync('pwsh.exe', ['-NoProfile', '-Command', "Compress-Archive -LiteralPath 'dist/CoFisher','dist/relay' -DestinationPath 'dist/CoFisher-2.0.0-offline.zip' -Force"], { cwd: root, stdio: 'inherit' });
console.log(path.join(root, 'dist', 'CoFisher-2.0.0-offline.zip'));
