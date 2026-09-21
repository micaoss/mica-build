#!/usr/bin/env python3
"""Export the built-in regulatory trust certificates from the configured kernel."""
import pathlib
import re
import subprocess
import sys

source = pathlib.Path(sys.argv[1])
config = (source / '.config').read_text().splitlines()
for option in ('CFG80211_REQUIRE_SIGNED_REGDB', 'CFG80211_USE_KERNEL_REGDB_KEYS'):
    if f'CONFIG_{option}=y' not in config:
        raise SystemExit(f'Missing built-in {option}')
certs = sorted((source / 'net/wireless/certs').glob('*.hex'))
if not certs:
    raise SystemExit('No kernel regulatory certificates')
image = (source / 'arch/arm64/boot/Image').read_bytes()
with pathlib.Path(sys.argv[2]).open('wb') as output:
    for cert in certs:
        der = bytes(int(value, 16) for value in re.findall(r'0x([0-9a-fA-F]{2})', cert.read_text()))
        if not der or der not in image:
            raise SystemExit(f'Regulatory certificate is absent from the built kernel: {cert.name}')
        pem = subprocess.run(['openssl', 'x509', '-inform', 'DER', '-outform', 'PEM'],
                             input=der, check=True, capture_output=True).stdout
        output.write(pem)
