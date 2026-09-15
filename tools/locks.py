#!/usr/bin/env python3
"""The inputs of this tree: locks/ (mica:docs/design/release-lock.md).

    locks.py check                          locks/: every lock, pin and locks/upstream.lock (CI mode under CI or GITHUB_ACTIONS)
    locks.py lock <file>                    one release lock
    locks.py upstream <file>                one locks/upstream.lock
    locks.py pins <dir> ci|local            a locks/ directory
    locks.py release <repository>           <release> TAB <commit> of that input
    locks.py image <source>:<name>[@<platform>]
                                            the reference of that image row; a repository image defaults to its
                                            index, an upstream image names its index digest on every platform row
    locks.py rows <kind> [<repository>]     every row of that kind, prefixed with its repository;
                                            the repository upstream.lock names the rows of locks/upstream.lock
    locks.py pin <repository>               the pin as KEY=value lines
    locks.py verify                         every pinned release: SHA256SUMS hashes to the pin and lists exactly
                                            the lock, whose bytes are the committed ones (network, no credential)

Every command except lock, upstream and pins first checks the whole locks/
directory, so no reader acts on a lock that breaks a rule. A refusal prints
`locks.py: refused <rule>: <detail>` and exits 1. Registry checks (a digest
reads back, a package is a layer of its pool) belong to the readers that
fetch: tools/pool.sh and tools/board-pool.sh.

UNTIL mica-boards PUBLISHES ITS FIRST LOCK, its release 20260914-1603 stays in
its old form, deps/releases/mica-boards.json and the deps/packages/*.json pins
of its packages, and is read here as the rows its lock will hold (legacy_boards);
both go when locks/mica-boards.lock arrives.
"""
import hashlib
import os
import re
import sys
import urllib.request

sys.dont_write_bytecode = True

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCKS = os.environ.get("MICA_LOCKS_DIR") or os.path.join(REPO_ROOT, "locks")
RELEASES = os.environ.get("MICA_LOCKS_RELEASES", "https://github.com/micaoss/{repository}/releases/download/{release}/")


class Refused(Exception):
    def __init__(self, rule, detail=""):
        super().__init__(rule)
        self.rule, self.detail = rule, detail


KIND_COLUMNS = {"release": 4, "image": 5, "pool": 3, "package": 5, "board": 4, "upstream": 7, "apt": 5}
KIND_ORDER = list(KIND_COLUMNS)
BASE_ONLY = {"upstream", "apt"}
UPSTREAM_COLUMNS = {"image": 5, "source": 6, "git": 5}
REPOSITORY = re.compile(r"^[a-z0-9][a-z0-9-]*$")
RELEASE = re.compile(r"^[0-9]{8}-[0-9]{4}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ARCH = {"amd64", "arm64"}
PLATFORM = {"index", "amd64", "arm64", "386"}
NAME = re.compile(r"^[a-z0-9][a-z0-9.+-]*$")
UPSTREAM_NAME = re.compile(r"^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$")
UPSTREAM_REFERENCE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?/[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$")
VERSION = re.compile(r"^[A-Za-z0-9.+~:-]+$")
REFERENCE = re.compile(r"^(?P<registry>ghcr\.io/micaoss|local)/(?P<repository>[a-z0-9][a-z0-9-]*)(?::(?P<tag>[A-Za-z0-9._-]+))?@sha256:(?P<digest>[0-9a-f]{64})$")


def lines_of(path, header):
    data = open(path, "rb").read()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("encoding", path)
    if not text.endswith("\n") or "\r" in text:
        raise Refused("encoding", path)
    lines = text[:-1].split("\n")
    if lines[0] != header:
        raise Refused("header", path)
    rows = []
    for line in lines[1:]:
        if line == "" or line.endswith("\t") or line.startswith(" "):
            raise Refused("encoding", f"{path}: {line!r}")
        if line.startswith("#"):
            continue
        rows.append(line.split("\t"))
    return rows


def field(ok, detail):
    if not ok:
        raise Refused("field-value", detail)


def check_upstream_image(row):
    field(UPSTREAM_NAME.match(row[2]) and row[3] in PLATFORM, "\t".join(row))
    if "@sha256:" not in row[4]:
        raise Refused("reference-digest", row[4])
    if row[4].startswith(("ghcr.io/micaoss/", "local/")):
        raise Refused("reference-upstream", row[4])
    field(UPSTREAM_REFERENCE.match(row[4]), row[4])


def check_lock(path):
    """The rows of a valid release lock; refuses at the first rule it breaks (1.5)."""
    rows = lines_of(path, "# mica-lock v1")
    for row in rows:
        if row[0] not in KIND_COLUMNS:
            raise Refused("kind-unknown", row[0])
        if len(row) != KIND_COLUMNS[row[0]]:
            raise Refused("column-count", "\t".join(row))
    if not rows or rows[0][0] != "release" or sum(r[0] == "release" for r in rows) != 1:
        raise Refused("release-row", path)
    _, repository, release, commit = rows[0]
    field(REPOSITORY.match(repository) and (RELEASE.match(release) or release == "offline") and COMMIT.match(commit), "\t".join(rows[0]))
    registry = "local" if release == "offline" else "ghcr.io/micaoss"

    def reference(value, expected=repository):
        if "@sha256:" not in value:
            raise Refused("reference-digest", value)
        m = REFERENCE.match(value)
        if not m:
            raise Refused("field-value" if value.startswith(("ghcr.io/micaoss/", "local/")) else "reference-registry", value)
        if m.group("registry") != registry:
            raise Refused("reference-registry", value)
        if m.group("repository") != expected:
            raise Refused("reference-repository", value)

    keys, pools, sort_keys = set(), set(), []
    for row in rows[1:]:
        kind = row[0]
        if kind == "image":
            if row[1] == "upstream":
                check_upstream_image(row)
            elif REPOSITORY.match(row[1]):
                field(NAME.match(row[2]) and row[3] in PLATFORM, "\t".join(row))
                reference(row[4], row[1])
                if row[1] != repository:
                    raise Refused("image-source", "\t".join(row))
            else:
                raise Refused("image-source", "\t".join(row))
            key = (row[1], row[2], row[3])
        elif kind == "pool":
            field(row[1] in ARCH, "\t".join(row))
            reference(row[2])
            key = (row[1],)
            pools.add(row[1])
        elif kind == "package":
            field(NAME.match(row[1]) and row[2] in ARCH and VERSION.match(row[3]) and SHA256.match(row[4]), "\t".join(row))
            key = (row[1], row[2])
        elif kind == "board":
            field(NAME.match(row[1]) and row[2] in ARCH, "\t".join(row))
            reference(row[3])
            key = (row[1],)
        elif kind == "upstream":
            roots = row[6].split(",")
            field(NAME.match(row[1]) and row[2] in ARCH and VERSION.match(row[3]) and SHA256.match(row[4])
                  and row[5].startswith("https://") and all(NAME.match(r) for r in roots) and roots == sorted(set(roots)), "\t".join(row))
            key = (row[1], row[2])
        elif kind == "apt":
            field(row[1].startswith("https://") and row[2] and row[3] and row[4].startswith("/"), "\t".join(row))
            key = ()
        else:
            raise Refused("release-row", "\t".join(row))
        if (kind,) + key in keys:
            raise Refused("duplicate-key", "\t".join(row))
        keys.add((kind,) + key)
        sort_keys.append((KIND_ORDER.index(kind),) + tuple(k.encode() for k in key))
    if repository != "mica-system-base" and any(r[0] in BASE_ONLY for r in rows):
        raise Refused("base-only-kind", path)
    if any(r[0] == "package" and r[2] not in pools for r in rows):
        raise Refused("package-without-pool", path)
    if sort_keys != sorted(sort_keys):
        raise Refused("sort-order", path)
    return rows


def check_upstream(path):
    rows = lines_of(path, "# mica-lock v1")
    for row in rows:
        if row[0] == "release":
            raise Refused("upstream-release-row", path)
        if row[0] not in UPSTREAM_COLUMNS:
            raise Refused("kind-unknown", row[0])
        if len(row) != UPSTREAM_COLUMNS[row[0]]:
            raise Refused("column-count", "\t".join(row))
    keys, sort_keys = set(), []
    order = list(UPSTREAM_COLUMNS)
    for row in rows:
        kind = row[0]
        if kind == "image":
            if row[1] != "upstream":
                raise Refused("image-source", "\t".join(row))
            check_upstream_image(row)
            key = (row[1], row[2], row[3])
        elif kind == "source":
            field(NAME.match(row[1]) and row[2] in ARCH | {"all"} and VERSION.match(row[3])
                  and SHA256.match(row[4]) and row[5].startswith("https://"), "\t".join(row))
            key = (row[1], row[2])
        else:
            field(NAME.match(row[1]) and row[2].startswith("https://") and row[3] and COMMIT.match(row[4]), "\t".join(row))
            key = (row[1],)
        if (kind,) + key in keys:
            raise Refused("duplicate-key", "\t".join(row))
        keys.add((kind,) + key)
        sort_keys.append((order.index(kind),) + tuple(k.encode() for k in key))
    if sort_keys != sorted(sort_keys):
        raise Refused("sort-order", path)
    return rows


def read_pin(path):
    data = open(path, "rb").read()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("encoding", path)
    if not text.endswith("\n") or "\r" in text:
        raise Refused("encoding", path)
    lines = text[:-1].split("\n")
    if lines[0] != "# mica-pin v1":
        raise Refused("header", path)
    pairs = [line.split("=", 1) if "=" in line else [line, None] for line in lines[1:]]
    keys = [k for k, _ in pairs]
    values = dict(pairs)
    offline = values.get("RELEASE") == "offline"
    if keys != (["REPOSITORY", "RELEASE", "SHA256SUMS"] + (["CHECKOUT"] if offline else [])):
        raise Refused("pin-format", path)
    field(REPOSITORY.match(values["REPOSITORY"] or "") and SHA256.match(values["SHA256SUMS"] or "")
          and (offline or RELEASE.match(values["RELEASE"] or "")), path)
    if offline:
        field(os.path.isabs(values["CHECKOUT"] or ""), path)
    return values


def check_pins(directory, mode):
    """{repository: (pin values, lock rows)} of a valid locks/ directory (section 4)."""
    pins_dir = os.path.join(directory, "pins")
    pins = sorted(f[:-4] for f in os.listdir(pins_dir) if f.endswith(".pin")) if os.path.isdir(pins_dir) else []
    locks = sorted(f[:-5] for f in os.listdir(directory) if f.endswith(".lock") and f != "upstream.lock")
    records = {}
    for repository in pins:
        values = read_pin(os.path.join(pins_dir, repository + ".pin"))
        if values["REPOSITORY"] != repository:
            raise Refused("name-mismatch", repository)
        records[repository] = values
    for repository in pins:
        if repository not in locks:
            raise Refused("pin-without-lock", repository)
    for repository in locks:
        if repository not in pins:
            raise Refused("lock-without-pin", repository)
    result = {}
    for repository, values in records.items():
        try:
            rows = check_lock(os.path.join(directory, repository + ".lock"))
        except Refused as refusal:
            raise Refused("lock-invalid", f"{repository}.lock: {refusal.rule} {refusal.detail}")
        if rows[0][1] != repository:
            raise Refused("lock-invalid", f"{repository}.lock names {rows[0][1]}")
        if rows[0][2] != values["RELEASE"]:
            raise Refused("release-mismatch", repository)
        if "CHECKOUT" in values and mode == "ci":
            raise Refused("checkout-in-ci", repository)
        result[repository] = (values, rows)
    return result


def mode():
    return "ci" if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS") else "local"


def legacy_boards(result):
    """The old-form mica-boards release as the rows of a lock; removed with the first locks/mica-boards.lock."""
    import json
    record_path = os.path.join(os.path.dirname(LOCKS), "deps", "releases", "mica-boards.json")
    if not os.path.exists(record_path):
        return
    if "mica-boards" in result:
        raise SystemExit(f"locks.py: error: locks/mica-boards.lock and {record_path} both pin mica-boards; remove deps/")
    record = json.load(open(record_path))
    if not (sorted(record) == ["boards", "commit", "pools", "release", "repository", "sha256sums", "transport", "url"]
            and record["repository"] == "mica-boards" and record["transport"] == "oci" and RELEASE.match(record["release"])
            and COMMIT.match(record["commit"]) and SHA256.match(record["sha256sums"]) and sorted(record["pools"]) == ["amd64", "arm64"]):
        raise SystemExit(f"locks.py: error: {record_path} is not the oci release record of mica-boards")
    tag = re.compile(r"^ghcr\.io/micaoss/mica-boards:(pool|board)\.([a-z0-9-]+)\." + record["release"] + r"@sha256:[0-9a-f]{64}$")
    rows = [["release", "mica-boards", record["release"], record["commit"]]]
    for arch, reference in sorted(record["pools"].items()):
        field(tag.match(reference) and tag.match(reference).group(2) == arch, reference)
        rows.append(["pool", arch, reference])
    arches = {}
    packages = []
    directory = os.path.join(os.path.dirname(LOCKS), "deps", "packages")
    for name in sorted(f[:-5] for f in os.listdir(directory) if f.endswith(".json")):
        pin = json.load(open(os.path.join(directory, name + ".json")))
        if pin.get("repository") != "mica-boards":
            raise SystemExit(f"locks.py: error: deps/packages/{name}.json pins {pin.get('repository')}; only mica-boards is still read from deps/")
        if pin.get("name") != name or pin.get("commit") != record["commit"] or not pin.get("targets"):
            raise SystemExit(f"locks.py: error: deps/packages/{name}.json is not a pin of mica-boards at {record['commit']}")
        for arch, target in sorted(pin["targets"].items()):
            field(arch in ARCH and VERSION.match(target["version"]) and SHA256.match(target["sha256"]), name)
            packages.append(["package", name, arch, target["version"], target["sha256"]])
        if name.startswith("mica-kernel-"):
            if len(pin["targets"]) != 1:
                raise SystemExit(f"locks.py: error: deps/packages/{name}.json pins {len(pin['targets'])} targets; a kernel has one")
            arches[name[len("mica-kernel-"):]] = next(iter(pin["targets"]))
    rows += packages
    if sorted(arches) != sorted(record["boards"]):
        raise SystemExit(f"locks.py: error: {record_path} names the boards {sorted(record['boards'])} and deps/packages pins kernels of {sorted(arches)}")
    for board, reference in sorted(record["boards"].items()):
        field(tag.match(reference) and tag.match(reference).group(2) == board, reference)
        rows.append(["board", board, arches[board], reference])
    result["mica-boards"] = ({"REPOSITORY": "mica-boards", "RELEASE": record["release"], "SHA256SUMS": record["sha256sums"]}, rows)


def inputs():
    result = check_pins(LOCKS, mode())
    upstream = os.path.join(LOCKS, "upstream.lock")
    if os.path.exists(upstream):
        check_upstream(upstream)
    legacy_boards(result)
    return result


def image(selector, records):
    source, _, rest = selector.partition(":")
    name, _, platform = rest.partition("@")
    if not source or not name:
        raise SystemExit(f"locks.py: error: '{selector}' is not <source>:<name>[@<platform>]")
    if source == "upstream":
        rows = [r for _, (_, lock) in records.items() for r in lock if r[0] == "image" and r[1] == "upstream" and r[2] == name]
        rows = [r for r in rows if not platform or r[3] == platform]
    else:
        lock = records.get(source, (None, []))[1]
        rows = [r for r in lock if r[0] == "image" and r[1] == source and r[2] == name and r[3] == (platform or "index")]
    references = sorted({r[4] for r in rows})
    if len(references) != 1:
        raise SystemExit(f"locks.py: error: {len(references)} image row(s) for {selector} in locks/"
                         + ("" if references else "; upstream images come only from the upstream rows of locks/mica-build-env.lock"))
    return references[0]


def verify(records):
    for repository, (values, _) in sorted(records.items()):
        if "CHECKOUT" in values:
            raise Refused("checkout-in-ci", f"{repository}: an offline pin names no published release")
        base = RELEASES.format(repository=repository, release=values["RELEASE"])
        sums = urllib.request.urlopen(base + "SHA256SUMS", timeout=120).read()
        if hashlib.sha256(sums).hexdigest() != values["SHA256SUMS"]:
            raise SystemExit(f"locks.py: error: SHA256SUMS of {repository} {values['RELEASE']} does not hash to the pinned {values['SHA256SUMS']}")
        if repository == "mica-boards" and not os.path.exists(os.path.join(LOCKS, "mica-boards.lock")):
            print(f"locks.py: {repository} {values['RELEASE']}: SHA256SUMS {values['SHA256SUMS'][:12]}, verified (old form, deps/releases/mica-boards.json)")
            continue
        listing = [line.split("  ", 1) for line in sums.decode().splitlines()]
        lock = open(os.path.join(LOCKS, repository + ".lock"), "rb").read()
        if listing != [[hashlib.sha256(lock).hexdigest(), repository + ".lock"]]:
            raise SystemExit(f"locks.py: error: SHA256SUMS of {repository} {values['RELEASE']} does not list exactly locks/{repository}.lock as committed")
        print(f"locks.py: {repository} {values['RELEASE']}: SHA256SUMS {values['SHA256SUMS'][:12]} lists locks/{repository}.lock, verified")


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == "lock":
            check_lock(argv[2])
        elif len(argv) == 3 and argv[1] == "upstream":
            check_upstream(argv[2])
        elif len(argv) == 4 and argv[1] == "pins":
            check_pins(argv[2], argv[3])
        elif len(argv) == 2 and argv[1] == "check":
            records = inputs()
            print("locks.py: locks/ is valid: " + ", ".join(r + " " + v[0]["RELEASE"] for r, v in sorted(records.items())))
            return 0
        elif len(argv) == 3 and argv[1] == "release":
            records = inputs()
            if argv[2] not in records:
                raise SystemExit(f"locks.py: error: locks/ holds no input {argv[2]}")
            print(records[argv[2]][1][0][2] + "\t" + records[argv[2]][1][0][3])
            return 0
        elif len(argv) == 3 and argv[1] == "image":
            print(image(argv[2], inputs()))
            return 0
        elif len(argv) in (3, 4) and argv[1] == "rows":
            records = inputs()
            if len(argv) == 4 and argv[3] == "upstream.lock":
                path = os.path.join(LOCKS, "upstream.lock")
                records = {"upstream.lock": ({}, check_upstream(path) if os.path.exists(path) else [])}
            for repository in sorted(records):
                if len(argv) == 4 and repository != argv[3]:
                    continue
                for row in records[repository][1]:
                    if row[0] == argv[2]:
                        print(repository + "\t" + "\t".join(row[1:]))
            return 0
        elif len(argv) == 3 and argv[1] == "pin":
            records = inputs()
            if argv[2] not in records:
                raise SystemExit(f"locks.py: error: locks/ holds no input {argv[2]}")
            for key, value in records[argv[2]][0].items():
                print(f"{key}={value}")
            return 0
        elif len(argv) == 2 and argv[1] == "verify":
            verify(inputs())
            return 0
        else:
            raise SystemExit(__doc__)
    except Refused as refusal:
        print(f"locks.py: refused {refusal.rule}" + (f": {refusal.detail}" if refusal.detail else ""), file=sys.stderr)
        if argv[1] in ("lock", "upstream", "pins"):
            print(f"refused {refusal.rule}")
        return 1
    if argv[1] in ("lock", "upstream", "pins"):
        print("valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
