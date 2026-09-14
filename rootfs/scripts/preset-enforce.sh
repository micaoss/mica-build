#!/bin/sh
# mica-build-side: container -- this edits the composed root inside the pack
# stage; nothing in this repository's checkout is touched.
#
# Make the enablement links in the packed root agree with the preset policy the
# root ships, for the units that policy DISABLES.
#
# WHY THIS EXISTS, AND WHY A PRESET FILE ALONE WAS NOT ENOUGH. mica-system's
# 50-mica-nftables.preset works by ORDERING: every payload is unpacked before
# nftables is configured, so deb-systemd-helper reads the rule and never writes
# the link. PLAN-088 assumed the same ordering would hold for
# getty@tty1.service and 50-mos-getty.preset. Measured on the assembled image,
# it does not: the packed root shipped the preset AND
# /etc/systemd/system/getty.target.wants/getty@tty1.service, because systemd is
# configured before the board package that carries the rule is unpacked. The
# preset is the right decision arriving too late to prevent the link.
#
# So both are needed and they do different jobs. The preset is the DECISION --
# it is what makes the state survive a `systemctl preset-all`, a new preset file
# or an upstream packaging change. This step is the RECONCILIATION -- it removes
# the link that was already there when the decision arrived. Removing the link
# without shipping the preset would be an absence rather than a decision, which
# is the failure mica-system's own comments describe at length.
#
# THE RESOLUTION IS IMPLEMENTED HERE RATHER THAN IMPORTED, and that is
# deliberate. verify/src/unit-state.ts implements the same systemd rule in
# TypeScript and verify/src/checks-display.ts asserts the OUTCOME over the
# packed root. Two independent readings of one rule, in two languages, with the
# checker as the oracle: if this enforcer's matching drifts, the check goes red
# rather than both agreeing with each other about the wrong thing.
#
# THE RULE, which is why none of this can be a grep for a `disable` line:
# preset files mask by BASENAME across /etc, /run and /usr/lib; the merged set
# is read in lexicographic order of that basename; and the FIRST rule matching
# the unit wins. A later `disable` behind an earlier `enable` is not policy, and
# a grep would find it anyway. A unit that NO rule matches presets to ENABLE.
#
# `systemctl --root ... preset` was measured and is not usable here: against the
# packed root it exits 0 and removes nothing for a template INSTANCE, while
# `systemctl --root ... disable getty@tty1.service` removes the link correctly.
# Rather than depend on that asymmetry -- and on running a foreign-architecture
# systemctl under emulation -- the link is unlinked directly, which is what
# rootfs/scripts/hwdb-remove.sh already does for the same job.
set -eu

PRESET_DIRS="/etc/systemd/system-preset /run/systemd/system-preset /usr/lib/systemd/system-preset"
UNIT_DIRS="/etc/systemd/system /usr/lib/systemd/system"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
MERGED="$TMP/merged"
RULES="$TMP/rules"
mkdir -p "$MERGED"
: >"$RULES"

# 1. Merge the preset files by basename, highest-precedence directory first.
for dir in ${PRESET_DIRS}; do
    [ -d "${dir}" ] || continue
    for f in "${dir}"/*.preset; do
        [ -f "${f}" ] || continue
        b=$(basename "${f}")
        [ -e "${MERGED}/${b}" ] || printf '%s\n' "${f}" >"${MERGED}/${b}"
    done
done

# 2. Read them in basename order into one rule list, first match first.
for b in $(ls "${MERGED}" 2>/dev/null | LC_ALL=C sort); do
    f=$(cat "${MERGED}/${b}")
    sed -e 's/[[:space:]]*[#;].*$//' -e '/^[[:space:]]*$/d' "${f}" |
        awk -v src="${f}" '$1 == "enable" || $1 == "disable" { print $1 "\t" $2 "\t" src }' >>"${RULES}"
done

rule_n=$(grep -c . "${RULES}" || true)
[ "${rule_n}" -gt 0 ] || {
    echo "error: no enable/disable rule was read from ${PRESET_DIRS}. This root ships mica preset files by rule, so an empty rule set means they are missing or unparseable -- and this step would then walk every enablement link, match nothing, and report success having enforced no policy at all" >&2
    exit 1
}

# 3. The first rule that claims a unit, consulting the unit and, for an
#    instance, the template it comes from -- which is how `disable getty@.service`
#    governs `getty@tty1.service`.
verdict_of() {
    _unit=$1
    _tmpl=$(printf '%s' "${_unit}" | sed -n 's/^\([^@]*@\)[^.]*\(\..*\)$/\1\2/p')
    while IFS='	' read -r _verb _pat _src; do
        # shellcheck disable=SC2254 -- the pattern is a systemd glob on purpose.
        case "${_unit}" in ${_pat}) printf '%s\t%s\n' "${_verb}" "${_src}"; return 0 ;; esac
        [ -n "${_tmpl}" ] || continue
        # shellcheck disable=SC2254
        case "${_tmpl}" in ${_pat}) printf '%s\t%s\n' "${_verb}" "${_src}"; return 0 ;; esac
    done <"${RULES}"
    return 1
}

# 4. Every enablement link in the root, against that policy. `.wants` AND
#    `.requires`: an [Install] section can name either, and a step that knew
#    only the first would leave half the mechanism in place.
examined=0
removed=0
for dir in ${UNIT_DIRS}; do
    for link in "${dir}"/*.wants/* "${dir}"/*.requires/*; do
        { [ -e "${link}" ] || [ -L "${link}" ]; } || continue
        unit=$(basename "${link}")
        examined=$((examined + 1))
        got=$(verdict_of "${unit}") || continue
        verb=${got%%	*}
        src=${got#*	}
        [ "${verb}" = disable ] || continue
        rm -f "${link}"
        if [ -d /mica-build-inputs ]; then
            printf '%s\t%s\n' "${link}" "${src}" >> /mica-build-inputs/preset-removed.tsv
        fi
        removed=$((removed + 1))
        echo "preset: removed ${link} (${src} says disable)"
    done
done

echo "preset: ${rule_n} rule(s), ${examined} enablement link(s) examined, ${removed} removed"
