#!/usr/bin/env python3
# The board's interface declarations against its device tree source, run by a board's kernel verify hook over
# the built tree (the board's .dts is a commit on its mica-linux branch, so the tree is where it is):
#   - every Ethernet MAC the DTS enables (`&gmac<n>` / `&ethmac<n>` with status "okay") is declared; a NIC on
#     PCIe or USB has no DTS node, so more declared Ethernet ports than enabled MACs is fine;
#   - the CAN controllers the DTS enables are exactly the declared CAN interfaces.
# The file's own contract and its Wi-Fi against BOARD_FEATURES are checked by tests/gates/board-interfaces.test.ts.
#
#   dts-interfaces-check.py <board.dts> <interfaces.json>
import json
import re
import sys


def enabled_nodes(dts):
    """The labels of the `&<label> { ... }` nodes of a DTS whose own body sets status = "okay"."""
    return [m.group(1) for m in re.finditer(r'^&([A-Za-z0-9_]+)\s*\{(.*?)^\};', dts, re.M | re.S)
            if re.search(r'^\s*status\s*=\s*"okay"\s*;', m.group(2), re.M)]


def faults(dts, declaration):
    if declaration.get('discover') is True:
        return []
    interfaces = declaration['interfaces']
    enabled = enabled_nodes(dts)
    count = lambda kind: sum(1 for i in interfaces if i['kind'] == kind)
    macs = [l for l in enabled if re.fullmatch(r'gmac\d*|ethmac\d*', l)]
    cans = [l for l in enabled if re.fullmatch(r'can\d+', l)]
    out = []
    if count('ethernet') < len(macs):
        out.append(f"the DTS enables {len(macs)} Ethernet MAC(s) ({' '.join(macs)}) and {count('ethernet')} Ethernet interface(s) are declared")
    if count('can') != len(cans):
        out.append(f"the DTS enables {len(cans)} CAN controller(s) ({' '.join(cans) or 'none'}) and {count('can')} CAN interface(s) are declared")
    return out


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: dts-interfaces-check.py <board.dts> <interfaces.json>')
    with open(sys.argv[1]) as f:
        dts = f.read()
    with open(sys.argv[2]) as f:
        declaration = json.load(f)
    found = faults(dts, declaration)
    for fault in found:
        print(f'error: {sys.argv[2]}: {fault}', file=sys.stderr)
    sys.exit(1 if found else 0)
