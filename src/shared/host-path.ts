// Docker bind sources are host paths. The station container sees /work and /root where the host daemon sees
// /srv/station/...; every `-v` this tree hands docker goes through here (bin/bun.sh's host_path, in TypeScript).
// A relative path is resolved first: docker takes a bind source that is not absolute for a volume name
// (CI run 35876186843, "_out/release/assets includes invalid characters for a local volume name").
import { resolve } from 'node:path'

export function hostPath(path: string): string {
  const absolute = resolve(path)
  if (absolute.startsWith('/work/')) return `/srv/station/work/${absolute.slice('/work/'.length)}`
  if (absolute.startsWith('/root/')) return `/srv/station/root/${absolute.slice('/root/'.length)}`
  return absolute
}
