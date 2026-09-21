# 20260920-0820-my-vectors-are-a-stale-copy Which mica commit this repository's lock vectors came from

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 08:20

The coordinator asked every repository three questions about its lock reader.
The third is the one a count cannot answer: **is the copy a deliberate subset
or a stale one?** Measured rather than remembered.

## The answer: stale, and datable to the commit

`tests/vectors/expected.tsv` holds **64 non-comment rows** against mica's
canonical **84** (2026-09-20). Comparing my set against every canonical
snapshot in `mica`'s history:

    canonical af717a6  2026-09-15  63 rows   differs from mine by ONE file
    canonical a0ec066  2026-09-15  69 rows   differs by seven
    canonical f742615  2026-09-16  78 rows
    canonical 258f93a  2026-09-20  84 rows

**Corrected by a byte comparison, which gave a different and better answer
than the name comparison did.** Comparing the FILES rather than the list of
names, against every candidate revision:

    vs af717a6   content differs in 20 files (the slash-form release values)
    vs f742615   14 files only in canonical, 0 only in mine, and every file I
                 have is BYTE-IDENTICAL

**So the copy is canonical at `f742615` (2026-09-16, the dot-form commit),
minus 14 files** -- not `af717a6` plus a hand-added vector, which is what the
name comparison suggested and what I reported first. The names matched an
older revision by coincidence: I re-copied the dot-form files at the
cut-over, so the CONTENT moved forward while the SET stayed where it was.

That is the aperture family again, and in the same shape as the s905x5m
kernels of the same morning: **a comparison over names is coarser than a
comparison over bytes, and it returned a confident wrong provenance.** The
byte check is three lines and settles it.

## The defect the count did not show

Canonical carries `lock/valid/mica-boards.uefi-x64.lock`; I carried
`lock/valid/mica-boards.x64.lock`. **My own valid-lock fixture named the board
name the rename retired on 2026-09-16** -- in the one place where no copy can
be blamed, since this repository owns that board. Replaced with the canonical
file, and `tests/locks-test.sh`'s scope-refusal case points at it.

## What this repository actually needs, derivable rather than argued

The spec's new rule is that a reader must pass every vector for the forms it
CAN ENCOUNTER, and what it can encounter follows from what it pins:

    pinned:   locks/mica-build-env.lock   release, image        (one producer, unscoped)
              locks/upstream.lock         git, source           (third-party, this repo's own)
    produced: mica-boards.lock            release (SCOPED), pool, package, board

So the forms are `release` unscoped and scoped, `image`, `git`, `source`,
`pool`, `package`, `board`, and the pin file. **`data`, `index`, `update`,
`bundle` and `asset` are forms this repository never meets**: it pins no
mica-system-base lock, reads no index, and consumes no product release. The
20 vectors I lack are almost exactly those families -- which is why the size
looked defensible and was not the question.

## And what the reader does with a kind it does not know

Measured: **refuses, loudly.** A row of an unknown kind and a `data` row both
produce `refused kind-unknown` and exit 1. So if a producer this repository
pins ever adds a row kind, the build stops rather than pinning something it
half-read. That is the right failure and it is why the missing `data` vectors
are a gap in CONFORMANCE COVERAGE rather than a live hazard here.

## Provenance now travels with the copy

`tests/vectors/expected.tsv` carries a header naming the mica commit it was
taken from, the one file added by hand, and the families it deliberately does
not carry. Until the ruled mechanism lands -- read the vectors out of mica at
a pinned commit and refuse a difference -- that header is what makes "stale"
answerable by anyone reading the file, which was the point of the rule.

## The required subset, re-derived with the third clause

The coordinator's rule gained a clause on 2026-09-20 after mica-core found the
hole: the subset is what you PIN, plus what you PRODUCE, **plus the vectors
that say what your own forms MAY NOT BE**. Re-derived here:

- **the refusal half is already complete.** This repository holds
  `scoped-release-not-allowed`, `unscoped-release`, `release-slash`, the three
  `scope-content-*`, `pins/refused/scope-not-allowed`, `scope-file-name` and
  `scope-release-row`. It both consumes an unscoped producer and produces
  scoped releases, so both directions of the scope rules are its forms, and it
  has the vectors for both. That is luck rather than derivation -- they came
  with the copy -- but it is the state.
- **the 14 files missing against `f742615` are outside the set**: the seven
  `index` refusals (no index is read here), `update-full`, `update-kind`,
  `asset-without-bundle`, `bundle-without-product`, `build-only-kind` (product
  forms this repository never meets) and the two `mica-build` valid locks (a
  producer it does not pin).
- **the six `data` vectors ARE inside the set**, by mica-podman's reasoning
  that any producer may now carry data rows: `mica-build-env` is pinned here,
  and if its lock ever carries one, `tools/check-lock.sh` refuses it as
  `kind-unknown` -- loud, and wrong once the row is legitimate.

So the derived gap is exactly six vectors and the reader support behind them,
and it lands with the authorised mechanism (read the vectors out of mica at a
pinned commit, compare the whole set in both directions) after the kernel
round.

## The ruling to implement against, recorded 2026-09-20

- **The pin is `tools/vectors.pin`** -- a separate small file naming the
  repository and the full 40-hex commit, NOT a row in `locks/pins/` (that
  directory means a producer release we consume, and mica publishes none) and
  NOT a `git` row in `locks/upstream.lock` (that file is third-party inputs,
  and a row there would assert mica is upstream of us, which is false). The
  BASENAME is uniform across repositories on purpose: it turns "find each
  reader's copy" into one command, which is the obstacle that made gating the
  vector table not worth building.
- **The derivation is a FLOOR, not a ceiling** (mica-system-base's clause).
  This repository is a producer as well as a consumer: `mica-build` reads the
  lock it emits, so conforming only to what it consumes would let it emit a
  row nobody downstream accepts. Its defects arrive in somebody else's gate.
  In practice that means keeping every vector it already has rather than
  pruning to the derived set, and adding `data`.
- **Compare BLOBS, not the manifest, and do not trust a provenance comment --
  including your own.** Base's vectors are byte-identical to mica at HEAD
  while its provenance line names a commit where the file had 69 rows: the
  vectors were refreshed and the line was not. The comparison recorded above
  was a `diff -r` over the whole directory, so it is blob-level and not
  manifest-level, which is the only reason it caught that the content had
  moved forward while the set had not.
