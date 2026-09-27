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

const PORT = 8181; // firebase.json emulators.firestore.port

/** PIDs of Firestore-emulator JVMs listening on PORT (Windows only). */
function emulatorPidsOnPort() {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8' }).stdout ?? '';
  const pids = new Set(
    out
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      // columns: proto, local address, foreign address, state, pid
      .filter((cols) => cols[3] === 'LISTENING' && (cols[1] ?? '').endsWith(`:${PORT}`))
      .map((cols) => cols[4]),
  );
  // Only ever the emulator JVM -- never whatever else might hold the port.
  return [...pids].filter((pid) => {
    const cmd =
      spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: 'utf-8' },
      ).stdout ?? '';
    return cmd.includes('cloud-firestore-emulator');
  });
}

// Windows: `emulators:exec` exits without stopping its JVM child, so every
// run leaked an emulator holding PORT and the NEXT run failed "port taken".
// Reap leftovers of this suite's emulator before, and our own JVM after.
function reap() {
  if (process.platform !== 'win32') return;
  for (const pid of emulatorPidsOnPort()) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
}

reap();
const r = spawnSync(
  'pnpm exec firebase emulators:exec --only firestore --project vayusetu-rules-test "pnpm exec vitest run"',
  { stdio: 'inherit', shell: true, env },
);
reap();
process.exit(r.status ?? 1);
