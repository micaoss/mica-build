# 20260919-1945-shared-radio-packages-stay-per-board The board-independent radio packages stay in each board's pool

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-19 19:45

## The question

`mica-bluetooth` is board-independent and every board that selects it
republishes the same bytes into its own board pool, so an assembly that
composes two of our boards sees the same package twice. mica-build's pool
check refused exactly that on `cx3576.20260917-1007`:

    pool.sh: error: mica-bluetooth is pinned twice for all

Is a board-independent package the right thing to publish per board?

## It is three packages, not one

Every shared radio package is duplicated between `cx3576` and `s905x5m`
today, with identical digests in both locks:

    mica-bluetooth  0.1.0-2  b4aad99443c136b239453158dc4666e81f4ea1b101dad3a0bc77906d90bc9e7f
    mica-wifi       0.1.0-2  041821f43b263cb4f23b02b36e5cf1fdd76875d6e4a699b9604891b1e0d5df55
    mica-wifi-ap    0.1.0-2  90cd08d996b57663c3169fad40abf1093bf86b2b3043687b7a303ad6b605b2ae

`mica-bluetooth` surfaced first; the same fix covers all three.

## Identical BY CONSTRUCTION, and measured across host architectures

The bytes cannot depend on the board, because the board is not an input:

- `producers/radio-bluetooth` is a plain producer, not a matrix one. There is
  no `FOR_EACH`, so there is one producer row and one build, invoked as
  `tools/deb/build.sh --producer radio-bluetooth --arch all` with no board
  argument anywhere in `tools/deb/build.sh`.
- its `BUILD_CONTEXTS` name `producers/radio` only, and its Dockerfile's
  arguments are `MICA_BUILD_BASE`, `MICA_DEB_VERSION`, `MICA_DEB_ARCH`,
  `SOURCE_DATE_EPOCH` and `MICA_DEB_SOURCE_REPO` -- not one of them board-derived.
- its `package-inputs.sh` manifest therefore contains no board path, and the
  version and epoch are declared once in its `version.env`.
- a board only SELECTS it: `tools/boards.sh producers <board>` decides which
  producers that board's pool builds.

The one vector that could still have made two boards differ is the host
architecture: an `all` archive is built once at the builder's own architecture
(`tools/deb/build.sh`, `BUILD_PLATFORM="${HOST_ARCH}"`) and exported to both
pools, and both bluetooth boards happen to be arm64, so CI has only ever built
these on arm64. Measured on 2026-09-19 by building them on this **amd64** host:

    mica-bluetooth_0.1.0-2_all.deb  b4aad99443c136b2...   identical to both boards' published archives
    mica-wifi_0.1.0-2_all.deb       041821f43b263cb4...   identical
    mica-wifi-ap_0.1.0-2_all.deb    90cd08d996b57663...   identical

So an amd64 board gaining Bluetooth would publish the same bytes as the arm64
boards do. Nothing in the tree can make them diverge.

## Decision: they stay per board

A board release is self-contained: one lock, one pool, and a consumer that
pins `cx3576` gets everything that board needs without pinning a second
release. That property is what makes per-board pinning simple in `mica-build`,
and it is worth more than the few tens of kilobytes of duplication.

What it costs, stated rather than hidden: a consumer composing two of our
boards sees the same `name/version/digest` twice and must collapse it.
Identical digests collapsing to one row and differing digests staying a
refusal -- mica-build's fix -- is the right rule, and it is the only place the
check can live: a release run here builds one board, so this repository never
sees two board pools at once.

The alternative, one owner, was rejected on its cost: a package published
outside a board pool needs a pool scope that is not a board, which is a change
to `mica:docs/design/release-lock.md`, a second release cadence, and a second
lock pinned by every consumer of a board that has a radio -- all to remove a
duplication the consumer collapses in one rule. Designating an owner board is
worse still: consumers of `s905x5m` would have to pin `cx3576`.

## What would change the answer

A board-conditional radio payload. It would mean one name covering two
different archives, which is a naming defect and not duplication. The tree
already answers it the right way and has an instance: the s905x5m vendor stack
ships as `mica-s905x5m-bluetooth`, its own name and its own producer, beside
the shared `mica-bluetooth`. A board that needs different bluetooth bytes gets
a different name, never a board-conditional `mica-bluetooth`.
