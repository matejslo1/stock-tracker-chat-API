const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const clientBuildDir = path.join(rootDir, 'client', 'build');
const serverPublicDir = path.join(rootDir, 'server', 'public');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (!fs.existsSync(clientBuildDir)) {
  throw new Error(`Client build directory not found: ${clientBuildDir}`);
}

ensureDir(serverPublicDir);
fs.rmSync(path.join(serverPublicDir, 'assets'), { recursive: true, force: true });
fs.rmSync(path.join(serverPublicDir, 'index.html'), { force: true });

for (const entry of fs.readdirSync(clientBuildDir, { withFileTypes: true })) {
  const srcPath = path.join(clientBuildDir, entry.name);
  const destPath = path.join(serverPublicDir, entry.name);
  if (entry.isDirectory()) {
    fs.rmSync(destPath, { recursive: true, force: true });
    copyDir(srcPath, destPath);
  } else {
    fs.copyFileSync(srcPath, destPath);
  }
}

console.log(`Copied static files from ${clientBuildDir} to ${serverPublicDir}`);
