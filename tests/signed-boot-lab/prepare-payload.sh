#!/usr/bin/env bash
# Assemble the payload the verity proofs boot with: two real root images, their
# root hashes, and five signatures over the first hash -- one valid, one by a
# key no kernel trusts, one with a byte changed, one cut short, and the valid
# signature over the OTHER root's hash.
#
#   A_SRC=_out/uefi-x64 B_SRC=<dir> bash tests/signed-boot-lab/prepare-payload.sh
#
# A_SRC and B_SRC are directories holding a `rootfs-verity.img` and its
# `rootfs-verity.env` -- what `rootfs/build.sh` leaves in `_out/<board>/`.
# BOTH ARE REQUIRED AND NEITHER HAS A DEFAULT: a default pointing at one
# checkout's output made this unrunnable anywhere else, and a proof that
# silently reads somebody else's artefact is not evidence about this tree.
#
# The signing key is meta/verity/signer.key.pem -- development material, minted
# by `bash pkgs/rauc/gen-dev-keys.sh --domain verity`, never committed. The
# throwaway "unrelated" key is minted per run under the work directory and is
# in no kernel's keyring, which is what makes a rejection a statement about WHO
# signed rather than about a parser.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

: "${A_SRC:?A_SRC must name a directory holding rootfs-verity.img and rootfs-verity.env}"
: "${B_SRC:?B_SRC must name a second such directory; the two-signed-roots proof needs two}"
A_SRC="$(cd "${A_SRC}" && pwd)"
B_SRC="$(cd "${B_SRC}" && pwd)"

PAY="${LAB_WORK}/payload"
rm -rf "${PAY}"; mkdir -p "${PAY}"

for pair in "a:${A_SRC}" "b:${B_SRC}"; do
    name="${pair%%:*}"; dir="${pair#*:}"
    for f in rootfs-verity.img rootfs-verity.env; do
        [ -s "${dir}/${f}" ] || { echo "error: ${dir}/${f} does not exist. It is written by rootfs/build.sh; this lab builds no root of its own" >&2; exit 1; }
    done
    cp "${dir}/rootfs-verity.img" "${PAY}/${name}.img"
    cp "${dir}/rootfs-verity.env" "${PAY}/${name}.env"
done
sed 's/^/B_/' "${PAY}/b.env" > "${PAY}/b.env.prefixed"

# The signed bytes are the 64 ASCII characters of the hash and nothing else:
# dm-verity hands verify_pkcs7_signature() the table's root-hash STRING with
# strlen() as its length, so a trailing newline would sign a 65-byte message
# the kernel never asks about.
for name in a b; do
    printf '%s' "$(sed -n 's/^VERITY_ROOT_HASH=//p' "${PAY}/${name}.env")" > "${PAY}/${name}.roothash"
    [ "$(stat -c%s "${PAY}/${name}.roothash")" = 64 ] ||
        { echo "error: ${PAY}/${name}.roothash is not 64 bytes; a sha256 root hash in lowercase ASCII is" >&2; exit 1; }
done

KEY="${REPO_ROOT}/meta/verity/signer.key.pem"
CERT="${REPO_ROOT}/meta/verity/signer.cert.pem"
[ -s "${KEY}" ] && [ -s "${CERT}" ] || {
    echo "error: meta/verity/ holds no development anchor. Mint one: bash pkgs/rauc/gen-dev-keys.sh --domain verity" >&2
    exit 1
}

OPENSSL_IMAGE="$(bash "${REPO_ROOT}/tools/from.sh" --ref mica-build-env:base)"
# mica-build-side: container-block -- every openssl below runs in the pinned
#   localhost/mica-build-openssl, the same image that minted the anchor; what a
#   signature contains is the signing openssl's decision
run_openssl() {
    docker run --rm --label ai-agent=true --name "ai-agent-signed-boot-lab-openssl-$$" \
        --user "$(id -u):$(id -g)" \
        -v "${REPO_ROOT}:${REPO_ROOT}" -v "${LAB_WORK}:${LAB_WORK}" -w "${REPO_ROOT}" \
        --entrypoint /bin/sh "${OPENSSL_IMAGE}" -c 'umask 0077; exec "$@"' -- openssl "$@"
}

run_openssl req -x509 -newkey rsa:2048 -keyout "${LAB_WORK}/unrelated.key.pem" \
    -out "${LAB_WORK}/unrelated.cert.pem" -days 3650 -nodes -sha256 \
    -subj "/O=mica development/CN=an unrelated key the kernel has never seen" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" 2>/dev/null

sign() {  # sign <hash-file> <key> <cert> <out>
    run_openssl smime -sign -nocerts -noattr -binary \
        -in "$1" -inkey "$2" -signer "$3" -outform DER -out "$4"
}
sign "${PAY}/a.roothash" "${KEY}" "${CERT}" "${PAY}/a.roothash.p7s"
sign "${PAY}/b.roothash" "${KEY}" "${CERT}" "${PAY}/b.roothash.p7s"
sign "${PAY}/a.roothash" "${LAB_WORK}/unrelated.key.pem" "${LAB_WORK}/unrelated.cert.pem" \
    "${PAY}/a.roothash.wrongkey.p7s"
# mica-build-side: host

# The two damaged forms, made with dd rather than a scripting language so that
# what changed is readable: the last byte replaced by a value it does not
# already hold, and the same signature twenty bytes short. Both are DER a
# parser can still walk into, and they fail at different points -- measured,
# -EKEYREJECTED for the first and -EBADMSG for the second.
SIG="${PAY}/a.roothash.p7s"
SIZE="$(stat -c%s "${SIG}")"
cp "${SIG}" "${PAY}/a.roothash.modified.p7s"
last="$(od -An -tx1 -j "$((SIZE - 1))" -N1 "${SIG}" | tr -d ' \n')"
if [ "${last}" = a5 ]; then new='\x5a'; else new='\xa5'; fi
printf "${new}" | dd of="${PAY}/a.roothash.modified.p7s" bs=1 seek="$((SIZE - 1))" conv=notrunc status=none
cmp -s "${SIG}" "${PAY}/a.roothash.modified.p7s" &&
    { echo "error: the modified signature is identical to the valid one, so that case would prove nothing" >&2; exit 1; }
dd if="${SIG}" of="${PAY}/a.roothash.truncated.p7s" bs=1 count="$((SIZE - 20))" status=none

chmod 0644 "${PAY}"/*.p7s
lab_note "payload in ${PAY}: $(ls "${PAY}" | tr '\n' ' ')"
lab_note "root A $(cat "${PAY}/a.roothash")"
lab_note "root B $(cat "${PAY}/b.roothash")"
