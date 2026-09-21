# 20260920-1730-the-vectors-are-read-from-mica-at-a-pin The lock vectors are mica's, at a pinned commit, checked both ways

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 17:30

Implements the ruling recorded in
[20260920-0820-my-vectors-are-a-stale-copy](20260920-0820-my-vectors-are-a-stale-copy.md):
`tools/vectors.pin`, the vectors read from mica at that commit, the whole set
compared in both directions, and `data` row support in the reader.

## What the refresh found, which is why the mechanism was worth building

The morning's measurement said the copy was canonical at `f742615` minus 14
files, every file byte-identical. Against canonical at `d73bdac` (today):

    32 files only in canonical      18 files differing in content
     8 files only here              -- all eight named `x64`

**All eight, and most of the eighteen, are the board rename this repository
performed on 2026-09-16.** `pins/valid/scoped/mica-boards.x64.lock`,
`pins/refused/scope-file-name/`, `scope-not-allowed/`, `scope-release-row/` and
their pins still named the board that no longer exists, four days later, in
fixtures about scope rules that this repository owns both ends of. The 08:20
record found ONE instance of that (`lock/valid/mica-boards.x64.lock`), fixed
that one, and did not sweep -- the same miss as the nineteen kconfig lines, on
the same day.

## The mechanism

- **`tools/vectors.pin`** (`mica-vectors-pin v1`: `REPOSITORY`, `COMMIT`, in
  that order, nothing else). mica specifies the format and publishes seven
  vectors for it; `tools/check-lock.sh vectors-pin` reads it and passes all
  seven. The basename is uniform across repositories on purpose.
- **`tests/vectors/excluded.tsv`**: the declared subset, one reason per path.
  This is the answer to the question a count cannot answer -- deliberate or
  stale -- written where the next reader is, and checked: an exclusion whose
  path has left canonical is refused, so a reason cannot outlive the thing it
  excused.
- **`tests/vectors-sync-test.sh`**, run by `make vectors-sync-test` and by CI
  beside `make deps` (it is the one gate here that reaches the network, so it
  stays out of the offline `make check`). Seven assertions: the pin is valid,
  the fetch answered with more than zero files, every exclusion still exists,
  every canonical file is carried or excluded, nothing here is absent from
  canonical, every carried file is **byte-identical**, and `expected.tsv` is
  canonical's table minus the excluded rows.
- **All five refusals were observed** before this was recorded: an edited
  vector, an invented file, a canonical file neither carried nor excluded, a
  stale exclusion, and a malformed pin.

`expected.tsv` is **derived, not copied**: the gate rebuilds it from canonical
and refuses a difference. It used to carry a provenance comment naming
`f742615`, which was true when written and wrong by the time it mattered --
the same shape mica-system-base hit from the other side, its provenance line
naming a 69-row revision while its vectors were byte-current.

## `data`, and a rule I invented and had to take back

`data <name> <file> <sha256>` (release-lock.md 1.2.4) is now read:
`COLUMNS[data]=4`, last in the kind order, key the name, and **not
base-only** -- any producer may carry one, and a reader that refuses a
legitimate row as `kind-unknown` stops a build over a correct release.

My first implementation required `<file>` to equal
`<repository>-<name>.tsv`, derived from the valid vector. Five of the six
vectors passed and `data-duplicate` returned `data-file` instead of
`duplicate-key`. **The rule is not derivation: `data-file` is two rows naming
the same FILE** (9.2's table), which is a different rule from two rows naming
the same name. I had generalised a filename convention out of one example into
a refusal that would have rejected valid locks. The vector caught it; the
example would not have.

## And three vectors that were carried and skipped

`tests/locks-test.sh` skipped the `repos/` family -- "this repository has no
source cache (repos.sh) yet" -- while `expected.tsv` counted its three rows.
Coverage that counts and asserts nothing. There is no `tools/repos.sh` here,
so the four `repos/` vectors are declared in `excluded.tsv` with that reason,
the skip is gone, and the loop now refuses a table row it cannot run.

The suite went from 82 to 95 assertions, and from 64 to 74 vectors.
