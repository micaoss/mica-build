#!/usr/bin/env python3
"""A release target's evidence.json, checked against the shape the assembly requires.

    python3 tests/evidence-schema.py boards/<board>/evidence.json <board>

The authority is `mica-build:build/src/release-manifest.ts` (the `evidence`
function): it reads the file as `board-evidence.json`, takes the product's
`bootAssurance` from it, and `gateRelease` re-reads it inside the assembled
directory. This is a pre-check, not a second authority: it exists because the
assembly validates at `--release assemble`, which runs AFTER the product's
archives and images are built, so a malformed file there costs a whole product
build. Keep it in step with that file; where they disagree, that file wins.
"""
import json
import re
import sys

# A path into a repository, not preceded by `<repository>:`. THE TOP-LEVEL
# NAMES ARE ENUMERATED, not derived: they are the directories the workspace's
# repositories actually have, and a new one has to be added here. What this
# catches is the shape that rotted -- on 2026-09-20 six of this repository's
# twelve evidence references named `tests/file-ab-uefi-x64/` and
# `tests/file-ab-fit/`, directories mica-build had renamed, and the bare form
# made them read as local paths that something here could resolve. NOTHING
# here can: every instrument these documents cite is in another repository.
#
# It asserts the citation says WHERE, not that the path exists. Resolving it
# would mean pinning a repository that consumes this one, which inverts the
# dependency, or pointing a gate at its `main`, which is a coupling worse than
# the staleness it catches.
BARE_PATH = re.compile(r"(?<![\w:/-])(?:verify|tests|build|boot|rootfs|tools|crates|src)/[A-Za-z0-9_./-]+")

LEVELS = {
    "I1": ["verity-root"],
    "I2": ["verity-root", "ab-fallback", "update-negative"],
    "I3": ["verity-root", "ab-fallback", "update-negative", "vendor-boot-capability", "signature-negative"],
    "I4": ["verity-root", "ab-fallback", "update-negative", "vendor-boot-capability", "signature-negative"],
}
KEYS = ["schemaVersion", "board", "revision", "bootAssurance", "qualification", "evidenceRefs", "physicalBoundaries"]
BOUNDARIES = ["jtag", "recoveryPath", "serialConsole"]


def main() -> None:
    path, board = sys.argv[1], sys.argv[2]
    try:
        doc = json.load(open(path))
    except Exception as error:
        sys.exit("%s is not JSON: %s" % (path, error))
    if sorted(doc) != sorted(KEYS):
        sys.exit("%s has keys %s; the assembly reads exactly %s" % (path, sorted(doc), sorted(KEYS)))
    if doc["schemaVersion"] != 2 or doc["board"] != board:
        sys.exit("%s is schemaVersion %r for board %r" % (path, doc["schemaVersion"], doc["board"]))
    for field in ("revision", "qualification"):
        if not isinstance(doc[field], str) or not doc[field].strip():
            sys.exit("%s: %s is empty" % (path, field))
    level = doc["bootAssurance"]
    if level not in LEVELS:
        sys.exit("%s: bootAssurance %r is not one of %s" % (path, level, ", ".join(sorted(LEVELS))))
    refs = doc["evidenceRefs"]
    if not isinstance(refs, list) or not refs:
        sys.exit("%s: evidenceRefs is empty" % path)
    classes = set()
    for ref in refs:
        if sorted(ref) != ["class", "ref"]:
            sys.exit("%s: an evidence reference is %s, not {class, ref}" % (path, sorted(ref)))
        if ref["class"] not in LEVELS["I4"]:
            sys.exit("%s: %r is not an evidence class the assembly knows" % (path, ref["class"]))
        if not isinstance(ref["ref"], str) or not ref["ref"].strip():
            sys.exit("%s: the %s reference is empty" % (path, ref["class"]))
        for bare in BARE_PATH.findall(ref["ref"]):
            sys.exit(
                "%s: the %s reference names %r without a repository. Every instrument this file"
                " cites lives in another repository -- there is no verify/ or tests/lifecycle-*/"
                " here -- so a bare path reads as local and cannot be resolved by anybody."
                " Write it as <repository>:<path> (mica:docs/README.md, *Workspace facts*)."
                % (path, ref["class"], bare)
            )
        classes.add(ref["class"])
    missing = [c for c in LEVELS[level] if c not in classes]
    if missing:
        sys.exit("%s claims %s without %s" % (path, level, ", ".join(missing)))
    boundaries = doc["physicalBoundaries"]
    if sorted(boundaries) != BOUNDARIES:
        sys.exit("%s: physicalBoundaries is %s; the assembly reads exactly %s" % (path, sorted(boundaries), BOUNDARIES))
    for name, text in boundaries.items():
        if not isinstance(text, str) or not text.strip():
            sys.exit("%s: the %s boundary is empty" % (path, name))
    print("%s: %s, %d reference(s)" % (path, level, len(refs)))


main()
