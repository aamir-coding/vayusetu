// Runs the rules suite inside `firebase emulators:exec` (port 8181, so it
// never collides with the dev emulator on 8081). The emulator needs Java:
// without it the suite is skipped locally with a hint, but FAILS in CI.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const java = spawnSync('java', ['-version'], { stdio: 'ignore', shell: true });
if (java.status !== 0) {
  const msg = 'firestore-rules: Java not found -- the Firestore emulator needs a JRE (17+).';
  if (process.env.CI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg} Skipping locally.`);
  process.exit(0);
}
// Windows: JDK 16+ builds NIO selector pipes on AF_UNIX sockets under %TEMP%,
// and socket paths are capped (~108 chars). With a long temp path the
// emulator dies with "failed to open a new selector" -- give Java a short dir.
const env = { ...process.env };
if (process.platform === 'win32') {
  const dir = process.env.VAYUSETU_JAVA_SOCKET_DIR ?? 'C:/vayusetu-jsock';
  mkdirSync(dir, { recursive: true });
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ?? ''} -Djdk.net.unixdomain.tmpdir=${dir}`.trim();
}
const r = spawnSync(
  'pnpm exec firebase emulators:exec --only firestore --project vayusetu-rules-test "pnpm exec vitest run"',
  { stdio: 'inherit', shell: true, env },
);
process.exit(r.status ?? 1);
