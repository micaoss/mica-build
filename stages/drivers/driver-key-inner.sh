#!/usr/bin/env bash
# mica-build-side: container -- runs only in the mica-build-env base image, from src/drivers/driver-key.ts:
# an owner's driver signing identity into /out, offline: a CA (owner-ca.cert.pem, the certificate a device
# admin enrols; owner-ca.key.pem, kept offline) and a signing leaf it issued (signer.key.pem, signer.cert.pem),
# which signs modules and driver extensions and travels in each signature.
#
#   driver-key-inner.sh <rsa|ecdsa> <name>
set -euo pipefail
umask 077
type="$1" name="$2"
case "${type}" in
rsa) newkey=(-newkey rsa:3072) ;;
ecdsa) newkey=(-newkey ec -pkeyopt ec_paramgen_curve:prime256v1) ;;
*) echo "driver-key: the key type is rsa or ecdsa, not '${type}'" >&2; exit 1 ;;
esac
cat > /tmp/ca.cnf <<EOF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = ext
[ dn ]
CN = ${name} driver CA
[ ext ]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
cat > /tmp/leaf.cnf <<EOF
[ ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
openssl req -new -x509 -nodes -utf8 -sha256 -days 7300 -batch -config /tmp/ca.cnf "${newkey[@]}" \
    -keyout /out/owner-ca.key.pem -out /out/owner-ca.cert.pem 2>/dev/null
openssl req -new -nodes -utf8 -sha256 -batch -subj "/CN=${name} driver signing" "${newkey[@]}" \
    -keyout /out/signer.key.pem -out /tmp/signer.csr 2>/dev/null
openssl x509 -req -sha256 -days 3650 -in /tmp/signer.csr -CA /out/owner-ca.cert.pem -CAkey /out/owner-ca.key.pem \
    -set_serial "0x$(openssl rand -hex 16)" -extfile /tmp/leaf.cnf -extensions ext -out /out/signer.cert.pem 2>/dev/null
openssl verify -CAfile /out/owner-ca.cert.pem /out/signer.cert.pem >/dev/null
chmod 0600 /out/owner-ca.key.pem /out/signer.key.pem
chmod 0644 /out/owner-ca.cert.pem /out/signer.cert.pem
openssl x509 -in /out/owner-ca.cert.pem -noout -subject -fingerprint -sha256
