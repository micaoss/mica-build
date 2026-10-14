#!/bin/sh
# Publish the upstream database only when the target kernel trusts its signature.
# mica-build-side: container -- OpenSSL runs in the pinned FIT packaging image.
set -eu
trust=${1:?target kernel regulatory certificate bundle required}
output=${2:?firmware output directory required}
db=/regdb/usr/lib/firmware/regulatory.db-upstream
signature=/regdb/usr/lib/firmware/regulatory.db.p7s-upstream
openssl cms -verify -binary -inform DER -in "$signature" -content "$db" \
    -CAfile "$trust" -no-CApath -no-CAstore -purpose any -out /dev/null
cp "$db" "$output/regulatory.db"
cp "$signature" "$output/regulatory.db.p7s"
