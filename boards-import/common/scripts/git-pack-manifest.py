#!/usr/bin/env python3
"""Read the mirror's git-pack manifest and print what fetch-source.sh must fetch.

    MANIFEST=<file> WANT=<commit> python3 git-pack-manifest.py
    -> <pack sha256> <pack size>
       <chunk 0 sha256> <chunk 0 size>
       ...

Refuses, with the reason on stderr and a non-zero status: anything that is not
the mica/git-pack/v1 schema, a manifest for another commit, and a malformed
sha256 or size. python3 rather than jq because the build-env images carry
python3 and no jq.
"""
import json
import os
import re
import sys

HEX = re.compile(r"^[0-9a-f]{64}$")


def main() -> None:
    try:
        manifest = json.load(open(os.environ["MANIFEST"]))
    except Exception as error:
        sys.exit("the mirror's manifest is not JSON: %s" % error)
    if manifest.get("schema") != "mica/git-pack/v1":
        sys.exit("the mirror's manifest is schema %r, not mica/git-pack/v1" % manifest.get("schema"))
    if manifest.get("commit") != os.environ["WANT"]:
        sys.exit("the mirror's manifest is for commit %r, not %s" % (manifest.get("commit"), os.environ["WANT"]))
    rows = [manifest.get("pack") or {}] + list(manifest.get("chunks") or [])
    for row in rows:
        if not HEX.match(str(row.get("sha256", ""))) or not isinstance(row.get("size"), int):
            sys.exit("the mirror's manifest has a row without a sha256 and a size: %r" % (row,))
    print("\n".join("%s %d" % (row["sha256"], row["size"]) for row in rows))


main()
