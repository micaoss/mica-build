# Local builds

A local build makes a product image out of local source checkouts so that it can be flashed and checked on
hardware **before anything is released**. Nothing is pushed or published: the inputs are pinned on a local
branch of this tree and the image is staged for whoever flashes it. Once the hardware passes, the producers
release as usual, this tree relocks to their real releases, and the product is released from that.

```sh
MICA_AP_SECRET_FILE=/path/to/ap-secret \
bin/local-build.sh cx3576.full [--core ../mica-core] [--pkgs ../mica-pkgs] [--podman ../mica-podman] \
    [--docker ../mica-docker] [--base ../mica-system-base] [--env ../mica-build-env] [--tools ../mica-build-tools] \
    [--build] [--no-gates] [--handover <name>] [--publish-test]
```

Each flag names a clean checkout. An input with no flag stays at its release pin in `locks/`.

There are two modes, and they use the same command:

- **A bench hand-over** is built the way the release will be. Every input that has a release stays at its release
  pin. Only the unreleased inputs are given as checkouts, for example `--core` alone while a core version waits for
  the hardware.
- **All local** gives every input as a checkout. It is for building without any access to a release, and it is not
  the hand-over the hardware is checked with. Give it its own `--handover` name, for example
  `--handover cx3576.full-alllocal`, so that it never replaces a bench hand-over.

The hand-over is in `_out/handover/<name>/` (by default the product's name):

- every image kind of the product, as `.img` (what the flasher writes) and `.img.gz` (`gzip -6`);
- the board's committed loader, where it has one (`boards/<board>/loader/*.bin` with its `.sha256`);
- `verify.log`;
- `SHA256SUMS` over all of these.

The last lines the command prints list every input: `local` (the checkout and commit it was built from),
`release` (the release it is still pinned at), or `upstream` (third-party sources and images, which no release of
ours carries).

## What it does

1. **Refuses under CI.** An offline pin is never a release input. The tools refuse one in CI (`checkout-in-ci`)
   and in every release build.
2. **Takes each producer's offline output.**
   - By default this is what is already in the checkout's `_out/`.
   - With `--build`, `make offline` (`bun run offline` where there is no Makefile) runs first, in a shared clone
     of the checkout under `_out/local-build/<stamp>/<repository>`, so the checkout itself is never written.
3. **Pins it**, with `bun src/cli.ts local-release <repository> <dir>`:
   - A producer that writes `_out/offline/` (mica-build-tools `docs/spec/release-lock.md` section 6) is pinned from
     it as it is.
   - For one whose `make offline` builds only its pools (`_out/debs/<arch>/pool`), that layout is written from the
     pools first, in a shared clone under `_out/local-releases/<repository>`. The pools must cover every
     architecture the release pins and hold each package at one version; pools left from different builds are
     refused.
   - Either way the result is the offline pin of section 7. The lock's release row is `offline`, its package and
     item rows name the versions built, and its `local/<repository>` references resolve in the pin's `CHECKOUT`.
4. **Pins the tools.** `--tools` pins mica-build-tools at the checkout's HEAD. It also sets `MICA_TOOLS_URL` to the
   checkout, so `bin/mica-tools` fetches that commit from it, and copies its `bootstrap/mica-tools` to
   `bin/mica-tools` when the two differ.
5. **Commits** `locks/` (and `bin/mica-tools`) on the branch `local/<product>-<stamp>`. The branch is never pushed.
6. **Runs the gates that read the inputs:** `locks-verify`, `os-pool` (the pools fetched and indexed from the
   pins, with the podman and deploy pool checks), `os-pool-check`, `os-apid-api-spec-pins`, `os-verify-test`. `locks-verify` refuses an offline pin (`checkout-in-ci`), and that
   refusal is the expected result. `--no-gates` skips them.
7. **Builds and verifies:** `product-build <product>`, then `product-build <product> --verify`, which must pass.
8. **Stages the hand-over** and returns the tree to the branch it started on. The local branch stays.
9. **Publishes it to the test channel** with `--publish-test` (next section).

## The test channel

`bin/test-publish <hand-over directory>` (or `--publish-test` above) puts a hand-over where testers can download
it, without a release: res's public, mutable namespace `mica-test` (mica-res `docs/modules/resource.md`, *Test
namespace*).

- **What goes up:** every file `SHA256SUMS` lists but the raw `.img`, and `SHA256SUMS` itself, each checked against
  it first. Testers check what they downloaded with `sha256sum -c --ignore-missing SHA256SUMS`.
- **Where:** `mica-test/<product>/<id>/<file>`, `<id>` the git id out of the image's name (`gitc4c1117d592f`),
  served at `https://dl.res.micaos.dev/mica-test/<product>/<id>/<file>`. In the same batch,
  `mica-test/<product>/latest/<file>` aliases point at those files (`https://res.micaos.dev/mica-test/<product>/latest/<file>`
  redirects there), and the object `mica-test/<product>/latest/ID` holds the id. The listing is
  `https://res.micaos.dev/mica-test/<product>/`.
- **How:** every file is a multipart upload, its parts strictly in order; a lost or failed part is resumed from the
  upload's status, an upload res refuses as a whole is started over, and one that cannot finish is aborted. All
  objects and aliases are published in one batch, then read back: the namespace's listing (sha256 and size) and
  every file downloaded from the download host.
- **The token:** a `res:publish` token of the user that publishes `mica-test` and nothing else, read from
  `MICA_RES_TEST_TOKEN_FILE` (default `/srv/micaoss/.secrets/res-test-token`), sent as a header and never printed.
- **Retention** is by hand, in res's admin console.

## Images from a local build

mica-system-base (the rootfs) and mica-build-env (the build images) publish images. Only a section 6 layout
carries images, so these two are taken from a checkout only when its offline build writes one. The image rows
then name `local/<repository>[:<tag>]@sha256:<digest>`, which no registry serves. `src/locks/local-images.ts`
makes them usable:

- **`docker run` and `docker create`.** The resolver (`src/locks/inputs.ts` `resolve`) loads the image into docker's
  store from the layout. It reads the blobs by digest under the reference's name, so the reference then resolves
  locally.
- **buildx builds.** A docker-container builder never sees that store, so the build takes the layout as a named
  context instead: `--build-context <reference>=oci-layout://<layout>@sha256:<digest>`, which its `FROM`
  resolves.

`bin/bun.sh`'s container route does not pull a `local/` image. It needs the image in the store already, which the
host route has loaded.

## Inputs and where a local checkout replaces them

| Input | Local today | Missing |
|---|---|---|
| mica-core, mica-pkgs, mica-podman, mica-docker | `make offline` (pools), then `local-release` | -- |
| mica-system-base | `bun run offline` (section 6: the rootfs images, pools, package, upstream, apt and data rows), then `local-release` | -- |
| mica-build-env | `make offline` (section 6: the host architecture's images and their indexes), then `local-release` | -- |
| mica-build-tools | `--tools` (the pin at the checkout's HEAD, fetched from it) | -- |
| board components (kernel, U-Boot, firmware) | built in `_out/<board>/` (`make <board>-kernel`, `-firmware`) | -- |
| `locks/upstream.lock`, upstream images, the Debian snapshot | third party, from `repos/` and the image store | not ours to build |
