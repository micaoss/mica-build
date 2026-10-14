# mica-build-side: container -- runs inside the install-closure roots tests/gates/install-closure.ts builds, never on the host.
# Shared by every in-root script: the counters, the ELF classification, and the
# ldd sweep. The sweep is a FUNCTION and not two copies because two roots run it
# -- the full resolution and the one with `mqtt` declined -- and the whole value
# of the second is that it is the same sweep over a different root.
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# dpkg-query's field for one package, in PKG_STATUS. Several assertions below
# read an empty answer as "the package is absent", which is the very fact they
# are testing, so an empty answer has to be distinguishable from a query that
# could not run: `dpkg-query ... || true` would turn an absent dpkg-query into
# the reassuring answer. Exit 1 is dpkg-query saying it knows nothing about the
# package, which is an answer; anything above 1, including the 127 of a missing
# binary, is no answer at all.
#
# Called as a command and never in $(...): a `fail` inside a command
# substitution would increment a subshell's counter and have its line captured
# instead of printed, so the failure would vanish exactly where it matters.
pkg_status() {
    local st=0
    PKG_STATUS="$(dpkg-query -W -f="$2" "$1" 2>/dev/null)" || st=$?
    [ "${st}" -le 1 ] ||
        fail "dpkg-query exited ${st} for $1, so its empty answer is a failed query and not a statement about the package"
}

# The ELF header's magic and its e_type, read once per file.
#
# e_type is what decides whether `ldd` means anything. ET_EXEC (2) and ET_DYN
# (3) are loaded by the dynamic linker and have sonames to resolve; ET_REL (1)
# is an object the kernel links itself -- every .ko in mica-board-cx3576 is one,
# and `ldd` over those would be thousands of meaningless invocations. Read out
# of the header rather than guessed from the path or the mode bit, so a module
# that arrived somewhere unexpected is still classified by what it is.
elf_type() {
    local hdr
    hdr="$(od -An -tx1 -N18 -- "$1" 2>/dev/null | tr -d ' \n')"
    case "${hdr}" in
    7f454c46*) ;;
    *) echo notelf; return ;;
    esac
    # Bytes 16 and 17, little-endian on both architectures this tree builds.
    case "${hdr:32:4}" in
    0100) echo rel ;;
    0200) echo exec ;;
    0300) echo dyn ;;
    *) echo other ;;
    esac
}

# dpkg's own record of what each named package shipped, so a package that gained
# or lost a file is covered without this script being edited.
collect_payload_paths() {
    local out="$1" p
    shift
    : >"${out}"
    for p in "$@"; do
        dpkg -L "${p}" 2>/dev/null >>"${out}" || true
    done
}

# ldd over every dynamically linked object a payload path names. Sets ELF_N,
# LDD_N and REL_N for the caller's COUNT lines; a zero is a hard failure, since
# "no unresolved soname" over no binaries is the report this gate exists to
# refuse.
ldd_sweep() {
    local paths_file="$1" label="$2" path out unresolved=""
    ELF_N=0
    LDD_N=0
    REL_N=0
    # Before the loop, because `ldd "${path}" || true` over a root without ldd
    # produces no "not found" line for any object, and the sweep would end in
    # the pass below: the absence of the measurement wearing the shape of a
    # clean result.
    if ! command -v ldd >/dev/null; then
        fail "${label}: ldd is not present in this root, so the sweep cannot be performed; no unresolved soname would only mean that nothing was examined"
        return
    fi
    while IFS= read -r path; do
        [ -f "${path}" ] || continue
        case "$(elf_type "${path}")" in
        notelf) continue ;;
        rel)
            ELF_N=$((ELF_N + 1))
            REL_N=$((REL_N + 1))
            continue
            ;;
        *) ELF_N=$((ELF_N + 1)) ;;
        esac
        LDD_N=$((LDD_N + 1))
        out="$(ldd "${path}" 2>&1 || true)"
        case "${out}" in
        *"not found"*)
            unresolved="${unresolved} ${path}[$(printf '%s\n' "${out}" | awk '/not found/ { printf "%s ", $1 }')]"
            ;;
        esac
    done <"${paths_file}"
    echo "install-closure: ${label}: ${ELF_N} ELF file(s) in the payload; ${LDD_N} loaded by the dynamic linker and examined with ldd; ${REL_N} ET_REL objects (kernel modules) not examined"
    if [ "${LDD_N}" -eq 0 ]; then
        fail "${label}: ldd examined ZERO objects. That is not 'everything linked', it is 'no binary was found', and a report of no unresolved sonames over no binaries is the exact shape this gate exists to refuse"
    elif [ -z "${unresolved}" ]; then
        pass "${label}: ldd over ${LDD_N} dynamically linked payload object(s) reports no unresolved soname"
    else
        fail "${label}: unresolved soname(s) in the installed root:${unresolved}"
    fi
}

# Every package the root holds, Mica OS and Debian alike, for the host to diff one
# root's against another's. Written out rather than summarised: which packages a
# declined feature took with it is the fact, and a count of them is not.
dump_pkgdb() {
    dpkg-query -W -f='PKGDB: ${Package} ${Version}\n' 2>/dev/null | sort || true
}

# The named packages out of /dist and the upstream rows of locks/mica-system-base.lock they
# need out of /upstream, in one offline dpkg transaction on the Base root, after
# writing the presets -- the transaction
# stages/compose/compose-install.sh runs. Sets INSTALL_STATUS; the log is
# /tmp/install.log.
install_set() {
    local p file archives=()
    install -D -m 0644 /in/system.preset /usr/lib/systemd/system-preset/40-mica-build.preset
    install -D -m 0644 /in/user.preset /usr/lib/systemd/user-preset/40-mica-build.preset
    awk -F'\t' -v list=" $* " '{ n = split($6, c, ","); for (i = 1; i <= n; i++) if (index(list, " " c[i] " ")) { print; next } }' /in/upstream.tsv >/tmp/upstream.tsv
    while IFS="$(printf '\t')" read -r p _ _ sha _ _; do
        archives+=("/upstream/${sha}.deb")
    done </tmp/upstream.tsv
    for p in "$@"; do
        file="$(awk -v package="${p}" 'BEGIN { RS = ""; FS = "\n" }
            { name = ""; f = ""; for (i = 1; i <= NF; i++) {
                if ($i ~ /^Package: /) name = substr($i, 10)
                if ($i ~ /^Filename: /) f = substr($i, 11)
            } if (name == package) print f }' /dist/Packages)"
        [ -n "${file}" ] && [ -f "/dist/${file}" ] || { echo "no archive for ${p} in /dist/Packages" >/tmp/install.log; INSTALL_STATUS=1; return; }
        archives+=("/dist/${file}")
    done
    INSTALL_STATUS=0
    { dpkg --unpack --skip-same-version "${archives[@]}" && dpkg --configure -a; } >/tmp/install.log 2>&1 || INSTALL_STATUS=$?
}
