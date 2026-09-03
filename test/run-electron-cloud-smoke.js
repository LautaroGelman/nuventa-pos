'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const electronBinary = require('electron');

function readCredentials() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    const finish = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      const normalized = input.trim();
      try { resolve(JSON.parse(normalized)); } catch {
        reject(new Error(`Entrada de credenciales inválida (bytes=${Buffer.byteLength(normalized)}, json=${normalized.startsWith('{') && normalized.endsWith('}')})`));
      }
    };
    const onData = (chunk) => {
      input += chunk;
      if (process.stdin.isTTY && /[\r\n]$/.test(input)) finish();
    };
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
  });
}

readCredentials().then((credentials) => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const pipeName = `\\\\.\\pipe\\nuventa-cloud-smoke-${process.pid}-${crypto.randomUUID()}`;
  const server = net.createServer((socket) => {
    socket.end(JSON.stringify(credentials));
    credentials.password = '';
  });
  server.on('error', (error) => {
    credentials.password = '';
    process.stderr.write(`[ELECTRON-CLOUD-SMOKE] credential pipe: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(pipeName, () => {
    const child = spawn(electronBinary,
      ['test/electron-cloud-smoke.js', '--dev', '--credential-pipe', pipeName, ...process.argv.slice(2)], {
        cwd: process.cwd(), env: environment, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
      });
    child.on('error', (error) => {
      credentials.password = '';
      server.close();
      process.stderr.write(`[ELECTRON-CLOUD-SMOKE] ${error.message}\n`);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      credentials.password = '';
      server.close();
      process.exitCode = code === 0 ? 0 : 1;
    });
  });
}).catch((error) => {
  process.stderr.write(`[ELECTRON-CLOUD-SMOKE] ${error.message}\n`);
  process.exitCode = 1;
});
