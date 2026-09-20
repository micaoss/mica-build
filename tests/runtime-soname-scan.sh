#!/usr/bin/env bash
# Every shared-object name a carried binary mentions, against what the root carries.
#
#   bash tests/runtime-soname-scan.sh <product>   (make os-soname-scan PRODUCT=<name>)
#
# THE QUESTION THE COMPOSER CANNOT ANSWER. Its declaration model proves a path by
# package ownership and keeps a library by DT_NEEDED; NEITHER SEES A RUNTIME LOAD
# BY NAME. /usr/bin/stdbuf is carried and /usr/libexec/coreutils/libstdbuf.so --
# the object it exists to LD_PRELOAD -- was dropped, so the tool runs, exits zero
# and silently does not buffer. Every dlopen family that IS carried is carried
# because somebody wrote a rule naming it: the NSS modules, the PAM modules, the
# openssl providers. This scan asks the question that foresight was answering.
#
# It keys on the NAME rather than on the mechanism, so it covers dlopen,
# LD_PRELOAD and exec-with-environment alike -- stdbuf dlopens nothing.
#
# IT IS A NECESSARY CONDITION AND NOT A PROOF, demonstrated rather than assumed:
# openssl's providers live in a directory read by name, so the carried legacy.so
# provider appears in neither list. A name assembled at run time is invisible.
#
# tests/runtime-sonames.json holds the classes of names that are absent ON
# PURPOSE, each with the reason that explains every member. UNEXPLAINED IS THE
# FINDING; the rest is arithmetic. Reports today and refuses when the count is
# zero and staying there.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
product=${1:?product name required}
root="_out/products/${product}/root/rootfs.img"
report="_out/products/${product}/build/rootfs-report.runtime.json"
[ -f "${root}" ] || { echo "error: ${root} does not exist; build the product first (make product PRODUCT=${product})" >&2; exit 1; }
# THE SIGNED ROOT IS WRITTEN BY `make product`; `make os-rootfs` REFRESHES ONLY
# build/. So a compose followed by a scan reads the PREVIOUS product's root and
# answers about it without saying so -- which it did to me: it reported
# libstdbuf.so still missing out of a sixteen-hour-old image, minutes after the
# declaration that carries it had gone into a freshly composed one.
[ ! "${report}" -nt "${root}" ] ||
    { echo "error: ${root} is older than ${report}; this scan would answer about the PREVIOUS product build. Run: make product PRODUCT=${product}" >&2; exit 1; }
work="$(mktemp -d "$PWD/_out/soname-scan.XXXXXX")"
trap 'rm -rf "${work}"' EXIT
# mica-build-side: container-block -- the root is read with the tools that packed it.
docker run --rm --label ai-agent=true --network none \
    -v "$PWD/_out/products/${product}/root:/r:ro" -v "${work}:/w" \
    "${MICA_BOOT_TOOLS_IMAGE:-ai-agent/mica-boot-tools-amd64}" sh -euc '
        unsquashfs -d /tmp/x /r/rootfs.img >/dev/null
        python3 - > /w/names.tsv <<'SCAN'
import os, re
pattern = re.compile(rb"lib[A-Za-z0-9._+-]{1,40}\.so(?:\.[0-9]+){0,3}")
carried, mentions = set(), {}
for directory, dirs, files in os.walk("/tmp/x"):
    carried.update(files); carried.update(dirs)
for directory, _, files in os.walk("/tmp/x"):
    for name in files:
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            with open(path, "rb") as handle:
                if handle.read(4) != b"\x7fELF":
                    continue
                handle.seek(0)
                data = handle.read()
        except OSError:
            continue
        for match in set(pattern.findall(data)):
            mentions.setdefault(match.decode(), set()).add(path[len("/tmp/x"):])
for name in sorted(mentions):
    state = "carried" if name in carried else "absent"
    print(name + "\t" + state + "\t" + ";".join(sorted(mentions[name])[:3]))
SCAN
'
# mica-build-side: host
python3 - "${work}/names.tsv" tests/runtime-sonames.json "${product}" <<'PY'
import json, sys
rows = [line.split("\t") for line in open(sys.argv[1]).read().splitlines()]
classes = json.load(open(sys.argv[2]))["classes"]
known = {name: (title, body["reason"]) for title, body in classes.items() for name in body["names"]}
absent = [(row[0], row[2] if len(row) > 2 else "") for row in rows if row[1] == "absent"]
counts = {}
unexplained = []
for name, where in absent:
    if name in known:
        counts[known[name][0]] = counts.get(known[name][0], 0) + 1
    else:
        unexplained.append((name, where))
print(f"soname scan: {len(rows)} name(s) mentioned by {sys.argv[3]}'s binaries, {len(absent)} not carried")
for title in sorted(counts):
    print(f"  {counts[title]:3d} explained: {title} -- {classes[title]['reason']}")
for name, where in unexplained:
    print(f"  UNEXPLAINED: {name}, named by {where}")
print(f"RESULT: {len(unexplained)} unexplained name(s) of {len(absent)} absent")
PY
