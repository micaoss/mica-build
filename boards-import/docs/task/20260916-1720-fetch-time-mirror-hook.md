# 20260916-1720-fetch-time-mirror-hook The fetch-time mirror, archives and git packs

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-16 17:20

## Description

mica-res mirrors every third-party object this repository pins. The builders
consult that mirror before a row's own URL, so a build works where a vendor
host is slow, rate-limited or gone. The contract, both halves, came from
mica-res through the coordinator and is implemented here in one round.

    archives   GET <mirror>/blob/<sha256[0:2]>/<sha256>
    git trees  GET <mirror>/d/upstream/git/<name>/<commit>.json
               GET <mirror>/d/upstream/git/<name>/<commit>.pack.<NN>   in order

## What was built

- `common/scripts/mirror.sh`, the only place that knows the mirror's URL
  shape, and the three rules it keeps: a lock URL is never rewritten, the
  mirror is a source and never a trust anchor, and not reachable is not an
  error.
- `common/scripts/fetch-archive.sh <sha256> <url> <dest>` for `source` rows:
  mirror first, the row's URL on a miss, and the row's sha256 either way.
- `common/scripts/fetch-source.sh --name <git row>` for `git` rows: the
  manifest, then every chunk in order with its sha256 checked, then the joined
  pack's sha256, then `git index-pack --stdin` into a fresh repository,
  `.git/shallow`, and `git checkout --detach <commit>`. The rev-parse assertion
  that was already there is unchanged and is the acceptance test.
- `common/scripts/fetch-source.sh --tag <ref>`, so the two UEFI kernels can
  join the shared script without losing what their inline clone had: they
  clone the tag and the assertion catches a tag moved upstream. Every builder
  now fetches through the two scripts; the inline clone and the inline
  `curl | sha256sum -c` pairs are gone.
- `common/scripts/git-pack-manifest.py`, the manifest reader. python3 rather
  than jq: the build-env images carry python3 and no jq.
- `MICA_MIRROR` reaches the builders as a build argument through each board
  Makefile's `MIRROR_ARG` and, in CI, from the repository variable of the same
  name. It is absent from `tools/inputs.sh` on purpose: the bytes are the same
  either way, so the mirror must not move a component's inputs hash.

## What is deliberately NOT in this round

`boards/s905x5m/loader/package/Dockerfile` fetches the Amlogic packer with
BuildKit's `ADD --checksum` inside `debian:trixie-slim`, which carries no curl
and into which nothing is installed by design. Routing it through the hook
would mean installing a fetcher into a pinned image, so that one `source` row
keeps going to its pinned URL. The mirror holds the bytes if that changes.

## Measured

- `tests/mirror-hook-test.sh`, 25 assertions, in `make check` as `mirror-test`.
  It serves mica-res's contract from a local `http.server` and covers: a mirror
  hit, a 404 falling back, a refused connection falling back, an unreachable
  mirror falling back within a bounded wait, wrong bytes from the mirror being
  refused rather than fetched again, wrong bytes from the row's URL being
  refused, a mirrored pack imported and `fsck` clean at the pinned commit with
  `.git/shallow` written, a row that is not mirrored cloning upstream, a wrong
  chunk sha256, a manifest for another commit, a manifest of another schema,
  and that `locks/upstream.lock` is byte-identical after all of it.
- The real builders, locally, with no mirror: the `uefi-x64` kernel `src` stage
  (the new `--tag` path, 62.8 s) and the `s905x5m` U-Boot `source` stage, which
  fetches the three vendor toolchains through `fetch-archive.sh` and the U-Boot
  tree through `fetch-source.sh`.
- The caveat the contract warns about, in a real builder. Scope first, because
  the measurement means nothing without it: what cannot reach `res.micaos.dev`
  is **container egress on this build host** -- the agent container this was
  run from. The mirror answers from GitHub runners (mica-res pulls from it by
  digest on a runner on every sync) and from the user's own machine. From this
  container DNS resolves to `2a06:98c1:3120::5` and TCP 443 times out after
  3.8 s. With `MICA_MIRROR=https://res.micaos.dev` the `uefi-x64` source stage
  printed `uefi-x64-kernel f717995cb7dc is not mirrored` after 3.178 s and
  finished normally: a mirror this network cannot reach costs one connect
  timeout per object and changes nothing else.

## Cost

`boards/s905x5m/Makefile` carries `MIRROR_ARG`, and that file is in the
bluetooth producer's `PREPARE_INPUTS`, so `mica-s905x5m-bluetooth` is
`0.1.0-6`. Measured against `b30b26b`: it is again the only producer that
moved. This is the declared cost of the decision recorded in
[20260916-1643](20260916-1643-s905x5m-packer-without-i386.md) -- one bump on
one package per board-Makefile edit, accepted over the risk of an
under-declared input -- and not a reason to revisit it.

## The shared UEFI pack, answered by mica-res

`uefi-x64-kernel` and `uefi-arm64-kernel` pin the same linux-stable commit and
the bucket holds the pack once -- answered by mica-res on 2026-09-16: the one
object carries both readable names and both resolve, with a distinct manifest
per row, so asking for our own row name is correct and neither board loses the
mirror. That is why the object count is 44 and not 49: 13 manifests and 31
chunks, the shared five-chunk pack stored once.

## 2026-09-18: the git pack path loses its `d/` prefix

mica-res was rebuilt as the resource service (`mica-res:docs/modules/resource.md`):
public files are served by R2 on `dl.res.micaos.dev` under their readable keys,
and `res.micaos.dev/upstream/git/...` redirects there. The git half of the
contract above is now `GET <mirror>/upstream/git/<name>/<commit>.{json,pack.<NN>}`;
the archive half, `blob/<sha256[0:2]>/<sha256>`, is unchanged, so
`MICA_MIRROR` stays `https://res.micaos.dev`. `mirror_get` already follows
redirects. On the day of the change the rebuilt namespaces listed empty and
both halves answered 404, which the hook treats as "not mirrored".

## Update 2026-09-19: a miss now says why, and both halves follow redirects

The mirror stopped answering this repository between CI runs: 11 of 11 fetches
mirrored on 2026-09-17 (run 35207062715, `48d995b`), 0 of 11 on 2026-09-19 (run
35454561921, `858d096`), with `MICA_MIRROR` unchanged. The archive lookup
`blob/<sha256[0:2]>/<sha256>` was not touched by that commit and misses too, so
the change is on the service side rather than in the path this repository
asks for.

The proposed explanation -- that `/blob/` now answers with a redirect and the
archive fetch does not follow it -- is ruled out by construction: there is one
`mirror_get`, used by both `fetch-archive.sh` and `fetch-source.sh`, and its
curl carries `-L`. It is now also ruled out by measurement:
`tests/mirror-hook-server.py` answers a `/r/` prefix with a 302, and the suite
fetches both an archive and a two-chunk pack through it (31 assertions).

What was missing was not the following of redirects but the reporting of a
miss. `2>/dev/null` swallowed curl's reason, so every outcome printed the same
"not mirrored" line, which is how a mirror can stop answering for two days with
every run green. `mirror_get` now records `MIRROR_STATUS`
(`curl <exit>, HTTP <code>, <n> redirect(s), <final url>`) and
`MIRROR_REDIRECTS`; a miss prints the status, and a hit that followed a
redirect says so. The next CI run therefore reports, per object, whether
`/blob/` answers, with what status, and whether a redirect was involved --
which is most of what mica-res was asked.

`MICA_MIRROR` is unchanged at `https://res.micaos.dev` pending that answer: if
digest lookups and readable paths end up on two different bases, the hook
changes shape rather than value.

## Update 2026-09-19, later: a missing chunk names itself

The restored mirror serves the `uefi-x64-kernel` manifest, which declares five
chunks, and 404s on `.pack.00` while `.pack.01`..`.pack.04` and every
`uefi-arm64-kernel` chunk answer. The cause corrects an answer recorded above:
the two UEFI trees do NOT share a pack. Their manifests declare different pack
digests, because git packing is not byte-deterministic; only their first 64 MiB
chunk happens to hash the same, and that one object was stored under the arm64
name only.

Nothing in this hook changes for it. Asking for our own row name is still
right, one base is still right, and a chunk that 404s falls back to the clone,
which is the designed behaviour. Deliberately NOT built: fetching a sibling
name, falling back to a digest lookup, or special-casing chunk 00. A mirror
with a hole is mica-res's to fix, and a consumer that routes around it would
hide the hole and depend on a layout nobody promised.

What did change is the miss line. It already carried the chunk index; it now
carries the status too:

    fetch-source.sh: the mirror has the manifest of <name> <commit> but not its
    chunk <i> of <n> (curl 22, HTTP 404, 0 redirect(s), <url>); fetching <repo>
    instead

`tests/mirror-hook-test.sh` grew the case that produces it -- manifest present,
chunk 00 removed -- asserting the index, the status and the fallback to the
pinned commit, 34 assertions. That case is this incident, kept.

Worth keeping as its own observation, because it is not a fault in the
diagnostics and will recur in other shapes: while the catalogue was empty the
manifest 404ed first, so the log said the tree was not mirrored -- true, and
not useful. A correct message can still be the wrong message when it reports
the first failure on a path whose interesting failure is further along. The
gap had to be found by walking the contract by hand; the fix is not a longer
message but a message from the failure that matters, which is what the chunk
line now is.
