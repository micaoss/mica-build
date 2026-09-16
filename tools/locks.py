#!/usr/bin/env python3
"""The inputs of this tree: locks/ (mica:docs/design/release-lock.md).

    locks.py check                          locks/: every lock, pin and locks/upstream.lock (CI mode under CI or GITHUB_ACTIONS)
    locks.py lock <file>                    one release lock
    locks.py upstream <file>                one locks/upstream.lock
    locks.py pins <dir> ci|local            a locks/ directory
    locks.py release <input>                <release> TAB <commit> of that input; an input is <repository>[.<scope>],
                                            and a bare repository names all its scopes when they share one commit
    locks.py image <source>:<name>[@<platform>]
                                            the reference of that image row; a repository image defaults to its
                                            index, an upstream image names its index digest on every platform row
    locks.py rows <kind> [<input>]          every row of that kind, prefixed with its input <repository>[.<scope>];
                                            the input upstream.lock names the rows of locks/upstream.lock
    locks.py pin <input>                    the pin as KEY=value lines
    locks.py checkout <repository>          the CHECKOUT of that repository's offline pins (one for all its scopes)
    locks.py verify                         every pinned release: SHA256SUMS hashes to the pin and lists exactly
                                            the lock, whose bytes are the committed ones (network, no credential)

Every command except lock, upstream and pins first checks the whole locks/
directory, so no reader acts on a lock that breaks a rule. A refusal prints
`locks.py: refused <rule>: <detail>` and exits 1. Registry checks (a digest
reads back, a package is a layer of its pool) belong to the readers that
fetch: tools/pool.sh and tools/board-pool.sh.

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


KIND_COLUMNS = {"release": 4, "image": 5, "pool": 3, "package": 5, "board": 5, "upstream": 7, "apt": 5,
                "input": 4, "origin": 3, "built": 5, "index": 3, "product": 8, "bundle": 4, "asset": 6}
KIND_ORDER = list(KIND_COLUMNS)
BASE_ONLY = {"upstream", "apt"}
BUILD_ONLY = {"input", "origin", "built", "index", "product", "bundle", "asset"}
# The Mica version index: a mica-build release of the reserved scope mica, which references scoped releases.
INDEX_SCOPE = "mica"
INDEX_KINDS = {"origin", "built", "index"}
INDEX_ALLOWED = {"release", "input", "origin", "built", "index", "product", "bundle", "asset"}
BUILD_INPUT = re.compile(r"^mica-build\.[a-z0-9][a-z0-9-]*$")
PROFILE = {"dev", "prod"}
GENERATION = re.compile(r"^[1-9][0-9]*$")
BUNDLE = {"image", "update"}
UPDATE_SUFFIX = {"full": "micaupd", "root": "root.micaupd", "kernel": "kernel.micaupd"}
UPSTREAM_COLUMNS = {"image": 5, "source": 6, "git": 5}
REPOSITORY = re.compile(r"^[a-z0-9][a-z0-9-]*$")
RELEASE = re.compile(r"^[0-9]{8}-[0-9]{4}$")
SCOPED = {"mica-boards", "mica-build"}
COMPONENT = {"board", "kernel", "uboot", "firmware", "packer"}
SCOPE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
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
    scope, _, release = release.rpartition(".")
    field(REPOSITORY.match(repository) and (RELEASE.match(release) or release == "offline") and COMMIT.match(commit)
          and (scope == "" or SCOPE.match(scope)), "\t".join(rows[0]))
    if (scope != "") != (repository in SCOPED):
        raise Refused("release-scope", "\t".join(rows[0]))
    if scope == INDEX_SCOPE and repository != "mica-build":
        raise Refused("index-scope", "\t".join(rows[0]))
    index_lock = repository == "mica-build" and scope == INDEX_SCOPE
    if any(r[0] in INDEX_KINDS for r in rows) != index_lock or (index_lock and not any(r[0] == "index" for r in rows)):
        raise Refused("index-scope", path)
    if any((r[0] == "product" and INDEX_SCOPE in (r[1], r[2])) or (r[0] == "board" and r[1] == INDEX_SCOPE) for r in rows):
        raise Refused("index-scope", path)
    if index_lock and any(r[0] not in INDEX_ALLOWED or (r[0] == "input" and not BUILD_INPUT.match(r[1])) for r in rows):
        raise Refused("index-only-inputs", path)
    if index_lock:
        inputs = [r[1] for r in rows if r[0] == "input"]
        if (any(r[0] == "index" and r[2] not in inputs for r in rows)
                or any(r[0] in ("origin", "built") and r[1] not in inputs for r in rows)
                or any(sum(r[0] == "origin" and r[1] == i for r in rows) != 1 or not any(r[0] == "built" and r[1] == i for r in rows) for i in inputs)):
            raise Refused("index-input", path)
    # The release each indexed product comes from: the release of its index row's input.
    input_release = {r[1]: r[2] for r in rows if r[0] == "input"}
    product_release = {r[1]: input_release.get(r[2]) for r in rows if r[0] == "index"}
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
        return m.group("tag") or ""

    board_scope = scope if repository == "mica-boards" else ""

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
            tag = reference(row[2])
            if board_scope and not tag.startswith("pool." + board_scope + "." + row[1] + "."):
                raise Refused("scope-content", "\t".join(row))
            key = (row[1],)
            pools.add(row[1])
        elif kind == "package":
            field(NAME.match(row[1]) and row[2] in ARCH and VERSION.match(row[3]) and SHA256.match(row[4]), "\t".join(row))
            key = (row[1], row[2])
        elif kind == "board":
            field(NAME.match(row[1]) and row[2] in COMPONENT and row[3] in ARCH, "\t".join(row))
            tag = reference(row[4])
            if board_scope and (row[1] != board_scope or not tag.startswith(row[2] + "." + row[1] + ".")):
                raise Refused("scope-content", "\t".join(row))
            key = (row[1], row[2])
        elif kind == "input":
            name, _, input_scope = row[1].partition(".")
            field(REPOSITORY.match(name) and (input_scope == "" or SCOPE.match(input_scope))
                  and (RELEASE.match(row[2]) or row[2] == "offline") and SHA256.match(row[3]), "\t".join(row))
            if (input_scope != "") != (name in SCOPED):
                raise Refused("release-scope", "\t".join(row))
            key = (row[1],)
        elif kind == "origin":
            field(BUILD_INPUT.match(row[1]) and COMMIT.match(row[2]), "\t".join(row))
            key = (row[1],)
        elif kind == "built":
            built_name, _, built_scope = row[2].partition(".")
            if not (BUILD_INPUT.match(row[1]) and REPOSITORY.match(built_name) and (built_scope == "" or SCOPE.match(built_scope))
                    and (built_scope != "") == (built_name in SCOPED) and built_name != "mica-build"
                    and (RELEASE.match(row[3]) or row[3] == "offline") and SHA256.match(row[4])):
                raise Refused("index-built-form", "\t".join(row))
            key = (row[1], row[2])
        elif kind == "index":
            field(SCOPE.match(row[1]) and BUILD_INPUT.match(row[2]), "\t".join(row))
            key = (row[1],)
        elif kind == "product":
            field(SCOPE.match(row[1]) and SCOPE.match(row[2]) and row[3] in PROFILE and GENERATION.match(row[4])
                  and all(SHA256.match(v) for v in row[5:8]), "\t".join(row))
            key = (row[1],)
        elif kind == "bundle":
            field(SCOPE.match(row[1]) and row[2] in BUNDLE, "\t".join(row))
            tag = reference(row[3])
            if index_lock:
                if product_release.get(row[1]) is None or tag != row[2] + "." + row[1] + "." + product_release[row[1]]:
                    raise Refused("index-product-source", "\t".join(row))
            key = (row[1], row[2])
        elif kind == "asset":
            asset_release = release
            if index_lock:
                asset_release = product_release.get(row[1])
                if asset_release is None or not row[4].startswith("mica-" + row[1] + "-" + asset_release + "."):
                    raise Refused("index-product-source", "\t".join(row))
            prefix = "mica-" + row[1] + "-" + asset_release + "."
            field(SCOPE.match(row[1]) and row[2] in BUNDLE and SHA256.match(row[5]) and row[4].startswith(prefix)
                  and (NAME.match(row[3]) if row[2] == "image" else row[4] == prefix + UPDATE_SUFFIX.get(row[3], "\n")), "\t".join(row))
            key = (row[1], row[2], row[3])
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
    if repository != "mica-build" and any(r[0] in BUILD_ONLY for r in rows):
        raise Refused("build-only-kind", path)
    if index_lock:
        if {r[1] for r in rows if r[0] == "product"} != set(product_release):
            raise Refused("index-product-source", path)
    products = {r[1] for r in rows if r[0] == "product"}
    bundles = {(r[1], r[2]) for r in rows if r[0] == "bundle"}
    if any(r[0] in ("bundle", "asset") and r[1] not in products for r in rows):
        raise Refused("bundle-without-product", path)
    if any(r[0] == "asset" and (r[1], r[2]) not in bundles for r in rows):
        raise Refused("asset-without-bundle", path)
    if any(r[0] == "bundle" and r[2] == "update" and not any(a[0] == "asset" and a[1:4] == [r[1], "update", "full"] for a in rows)
           for r in rows):
        raise Refused("update-full", path)
    if any(r[0] == "package" and r[2] not in pools for r in rows):
        raise Refused("package-without-pool", path)
    if repository == "mica-boards" and not {"board", "kernel"} <= {r[2] for r in rows if r[0] == "board"}:
        raise Refused("board-components", path)
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
    scoped = "SCOPE" in values
    if keys != (["REPOSITORY"] + (["SCOPE"] if scoped else []) + ["RELEASE", "SHA256SUMS"] + (["CHECKOUT"] if offline else [])):
        raise Refused("pin-format", path)
    field(REPOSITORY.match(values["REPOSITORY"] or "") and SHA256.match(values["SHA256SUMS"] or "")
          and (offline or RELEASE.match(values["RELEASE"] or "")) and (not scoped or SCOPE.match(values["SCOPE"] or "")), path)
    if offline:
        field(os.path.isabs(values["CHECKOUT"] or ""), path)
    return values


def check_pins(directory, mode):
    """{input: (pin values, lock rows)} of a valid locks/ directory (section 4); an input is <repository>[.<scope>]."""
    pins_dir = os.path.join(directory, "pins")
    pins = sorted(f[:-4] for f in os.listdir(pins_dir) if f.endswith(".pin")) if os.path.isdir(pins_dir) else []
    locks = sorted(f[:-5] for f in os.listdir(directory) if f.endswith(".lock") and f != "upstream.lock")
    records = {}
    for name in pins:
        values = read_pin(os.path.join(pins_dir, name + ".pin"))
        repository, _, scope = name.partition(".")
        if values["REPOSITORY"] != repository:
            raise Refused("name-mismatch", name)
        if values.get("SCOPE", "") != scope:
            raise Refused("scope-mismatch", name)
        if ("SCOPE" in values) != (repository in SCOPED):
            raise Refused("release-scope", name)
        records[name] = values
    for name in pins:
        if name not in locks:
            raise Refused("pin-without-lock", name)
    for name in locks:
        if name not in pins:
            raise Refused("lock-without-pin", name)
    result = {}
    for name, values in records.items():
        try:
            rows = check_lock(os.path.join(directory, name + ".lock"))
        except Refused as refusal:
            raise Refused("lock-invalid", f"{name}.lock: {refusal.rule} {refusal.detail}")
        if rows[0][1] != values["REPOSITORY"]:
            raise Refused("lock-invalid", f"{name}.lock names {rows[0][1]}")
        scope, _, release = rows[0][2].rpartition(".")
        if scope != values.get("SCOPE", ""):
            raise Refused("scope-mismatch", name)
        if release != values["RELEASE"]:
            raise Refused("release-mismatch", name)
        if "CHECKOUT" in values and mode == "ci":
            raise Refused("checkout-in-ci", name)
        result[name] = (values, rows)
    return result


def mode():
    return "ci" if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS") else "local"


def inputs():
    result = check_pins(LOCKS, mode())
    upstream = os.path.join(LOCKS, "upstream.lock")
    if os.path.exists(upstream):
        check_upstream(upstream)
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
        rows = [r for n, (_, lock) in records.items() if n.partition(".")[0] == source
                for r in lock if r[0] == "image" and r[1] == source and r[2] == name and r[3] == (platform or "index")]
    references = sorted({r[4] for r in rows})
    if len(references) != 1:
        raise SystemExit(f"locks.py: error: {len(references)} image row(s) for {selector} in locks/"
                         + ("" if references else "; upstream images come only from the upstream rows of locks/mica-build-env.lock"))
    return references[0]


def verify(records):
    for repository, (values, _) in sorted(records.items()):
        if "CHECKOUT" in values:
            raise Refused("checkout-in-ci", f"{repository}: an offline pin names no published release")
        base = RELEASES.format(repository=values["REPOSITORY"], release=records[repository][1][0][2])
        sums = urllib.request.urlopen(base + "SHA256SUMS", timeout=120).read()
        if hashlib.sha256(sums).hexdigest() != values["SHA256SUMS"]:
            raise SystemExit(f"locks.py: error: SHA256SUMS of {repository} {values['RELEASE']} does not hash to the pinned {values['SHA256SUMS']}")
        listing = [line.split("  ", 1) for line in sums.decode().splitlines()]
        lock = open(os.path.join(LOCKS, repository + ".lock"), "rb").read()
        if listing != [[hashlib.sha256(lock).hexdigest(), values["REPOSITORY"] + ".lock"]]:
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
            named = [n for n in records if n == argv[2] or n.partition(".")[0] == argv[2]]
            if not named:
                raise SystemExit(f"locks.py: error: locks/ holds no input {argv[2]}")
            commits = sorted({records[n][1][0][3] for n in named})
            if len(commits) != 1:
                raise SystemExit(f"locks.py: error: the inputs {', '.join(sorted(named))} name {len(commits)} commits; name one input <repository>.<scope>")
            print(",".join(records[n][1][0][2] for n in sorted(named)) + "\t" + commits[0])
            return 0
        elif len(argv) == 3 and argv[1] == "checkout":
            records = inputs()
            checkouts = sorted({v.get("CHECKOUT", "") for n, (v, _) in records.items() if n.partition(".")[0] == argv[2]})
            if len(checkouts) != 1 or checkouts[0] == "":
                raise SystemExit(f"locks.py: error: {argv[2]} has no one offline pin CHECKOUT in locks/ (found {len(checkouts)})")
            print(checkouts[0])
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
