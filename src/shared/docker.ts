// The docker client this tree runs: MICA_BUILD_DOCKER names it (bin/bun.sh's container route bind-mounts the
// host's client at its own path and names it so; a test names an argument recorder), a bare `docker` otherwise.
// The same answer src/image/stages-cli.ts and src/image/toolbox.ts give.
import { existsSync } from 'node:fs'

export function dockerBin(): string {
  return process.env['MICA_BUILD_DOCKER'] || 'docker'
}

/** Whether the client is there to run, without running it (a recorder counts every call). */
export function dockerAvailable(): boolean {
  const bin = dockerBin()
  return bin.includes('/') ? existsSync(bin) : Bun.which(bin) !== null
}
