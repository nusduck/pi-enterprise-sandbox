/**
 * Basic usage example for Pi Enterprise Sandbox SDK.
 *
 * Run with: `node examples/basic.js`
 */

import { SandboxClient } from 'pi-enterprise-sandbox-sdk';

async function main() {
  // ── 1. Create a client ─────────────────────────────────────────────────
  const client = new SandboxClient({
    sandboxUrl: 'http://localhost:8083',
  });

  // ── 2. Create a session ────────────────────────────────────────────────
  console.log('Creating session...');
  const session = await client.createSession('example');
  console.log('Session created:', session.session_id);

  try {
    // ── 3. Execute a command ─────────────────────────────────────────────
    console.log('\nRunning command...');
    const cmdResult = await client.executeCommand(
      session.session_id,
      'echo hello && whoami',
    );
    console.log('stdout:', cmdResult.stdout_preview);
    console.log('exit code:', cmdResult.exit_code);

    // ── 4. Execute Python code ───────────────────────────────────────────
    console.log('\nRunning Python...');
    const pyResult = await client.executePython(
      session.session_id,
      'print("Hello from Python!")',
    );
    console.log('stdout:', pyResult.stdout_preview);

    // ── 5. Write a file ──────────────────────────────────────────────────
    console.log('\nWriting file...');
    const writeResult = await client.writeFile(
      session.session_id,
      'hello.txt',
      'Hello, Sandbox!',
    );
    console.log('Written:', writeResult.path);

    // ── 6. List files ────────────────────────────────────────────────────
    console.log('\nListing files...');
    const files = await client.listFiles(session.session_id);
    console.log('Files:', files.files.map(f => `  ${f.name} (${f.type})`).join('\n'));

    // ── 7. Read a file ───────────────────────────────────────────────────
    console.log('\nReading file...');
    const fileContent = await client.readFile(session.session_id, 'hello.txt');
    console.log('Content:', fileContent.content);

    // ── 8. List artifacts ────────────────────────────────────────────────
    console.log('\nListing artifacts...');
    const artifacts = await client.listArtifacts(session.session_id);
    console.log('Artifacts:', artifacts.total);

    // ── 9. Health check ──────────────────────────────────────────────────
    console.log('\nChecking health...');
    const health = await client.health();
    console.log('Status:', health.status);
    console.log('Version:', health.version);
    console.log('Active sessions:', health.sessions_active);
  } finally {
    // ── 10. Clean up ────────────────────────────────────────────────────
    console.log('\nDeleting session...');
    await client.deleteSession(session.session_id);
    console.log('Session deleted.');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
