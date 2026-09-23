// Docker bind sources are host paths. The station container sees /work and /root where the host daemon sees
// /srv/station/...; every `-v` this tree hands docker goes through here (bin/bun.sh's host_path, in TypeScript).
export function hostPath(path: string): string {
  if (path.startsWith('/work/')) return `/srv/station/work/${path.slice('/work/'.length)}`
  if (path.startsWith('/root/')) return `/srv/station/root/${path.slice('/root/'.length)}`
  return path
}
