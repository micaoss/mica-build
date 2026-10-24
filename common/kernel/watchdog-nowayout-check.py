#!/usr/bin/env python3
"""Every watchdog driver a board's kernel enables sets NOWAYOUT on its device.

    watchdog-nowayout-check.py <kernel-source> <.config> <exceptions>

mica-init requires /sys/class/watchdog/*/nowayout == 1, and that attribute reports only what the driver
set with watchdog_set_nowayout(): CONFIG_WATCHDOG_NOWAYOUT=y alone is not enough (msc313e_wdt never set
it, and the ssd202d /init refused to boot). So each CONFIG_* the .config enables (=y or =m) that a
drivers/watchdog Makefile builds -- the kernel's own and any vendor tree's, e.g. common_drivers/ -- must
have a source that calls watchdog_set_nowayout(), or be listed in <exceptions> (`CONFIG_<SYMBOL><TAB>why`,
`#` comments; `-` for none). The watchdog core and its pretimeout governors are the framework, not
drivers. An exception that names a symbol the config does not enable, or a driver that does call it, is
refused as stale. Exit 1 names every fault.
"""
import os
import re
import sys

FRAMEWORK = re.compile(r'^CONFIG_WATCHDOG_(CORE|DEV|PRETIMEOUT_.*|HRTIMER_PRETIMEOUT)$')


def makefiles(src):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        if os.path.basename(root) == 'watchdog' and os.path.basename(os.path.dirname(root)) == 'drivers' and 'Makefile' in files:
            yield root, os.path.join(root, 'Makefile')


def objects(path):
    """{CONFIG_SYMBOL: [source paths]} of one kbuild Makefile, composite objects and $(VAR) names resolved."""
    text = re.sub(r'\\\n', ' ', open(path, encoding='utf-8', errors='replace').read())
    variables, built, parts = {}, {}, {}
    expand = lambda s: re.sub(r'\$\(([A-Za-z0-9_]+)\)', lambda m: variables.get(m.group(1), m.group(0)), s)
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if m := re.match(r'^obj-\$\((CONFIG_[A-Z0-9_]+)\)\s*[+:]?=\s*(.*)$', line):
            built.setdefault(m.group(1), []).extend(expand(m.group(2)).split())
        elif m := re.match(r'^([A-Za-z0-9_$()-]+)-(y|objs)\s*[+:]?=\s*(.*)$', line):
            parts.setdefault(expand(m.group(1)), []).extend(expand(m.group(3)).split())
        elif m := re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(.*)$', line):
            variables[m.group(1)] = expand(m.group(2))
    root = os.path.dirname(path)
    sources = {}
    for symbol, objs in built.items():
        for obj in objs:
            if not obj.endswith('.o'):
                continue
            stem = obj[:-2]
            for part in parts.get(stem, [obj]):
                if part.endswith('.o'):
                    sources.setdefault(symbol, []).append(os.path.join(root, part[:-2] + '.c'))
    return sources


def main(src, config, exceptions):
    enabled = set()
    for line in open(config, encoding='utf-8'):
        if m := re.match(r'^(CONFIG_[A-Z0-9_]+)=[ym]$', line.strip()):
            enabled.add(m.group(1))
    excepted = {}
    if exceptions != '-':
        for n, line in enumerate(open(exceptions, encoding='utf-8'), 1):
            line = line.rstrip('\n')
            if not line.strip() or line.startswith('#'):
                continue
            cells = line.split('\t')
            if len(cells) != 2 or not re.match(r'^CONFIG_[A-Z0-9_]+$', cells[0]) or not cells[1].strip():
                return [f'{exceptions}:{n}: not `CONFIG_<SYMBOL><TAB>why`']
            excepted[cells[0]] = cells[1].strip()
    drivers = {}
    for _, mk in makefiles(src):
        for symbol, srcs in objects(mk).items():
            drivers.setdefault(symbol, []).extend(srcs)
    faults, seen = [], set()
    for symbol in sorted(enabled & set(drivers)):
        if FRAMEWORK.match(symbol):
            continue
        seen.add(symbol)
        srcs = [s for s in drivers[symbol] if os.path.isfile(s)]
        calls = [s for s in srcs if 'watchdog_set_nowayout(' in open(s, encoding='utf-8', errors='replace').read()]
        rel = lambda s: os.path.relpath(s, src)
        if calls and symbol in excepted:
            faults.append(f'{symbol}: listed as an exception, but {rel(calls[0])} calls watchdog_set_nowayout(); drop the stale exception')
        elif calls:
            print(f'watchdog: {symbol}: {rel(calls[0])} calls watchdog_set_nowayout()')
        elif symbol in excepted:
            print(f'watchdog: {symbol}: no watchdog_set_nowayout(), excepted: {excepted[symbol]}')
        elif not srcs:
            faults.append(f'{symbol}: enabled, and none of its sources ({", ".join(rel(s) for s in drivers[symbol])}) is in the tree to read')
        else:
            faults.append(f'{symbol}: enabled, and {", ".join(rel(s) for s in srcs)} never calls watchdog_set_nowayout(), so its '
                          '/sys/class/watchdog/*/nowayout reads 0 and mica-init refuses to boot; set it in probe, or list the '
                          'symbol with the reason in the board\'s exceptions')
    for symbol in sorted(set(excepted) - seen):
        faults.append(f'{symbol}: listed as an exception, but the config does not build it as a watchdog driver; drop the stale exception')
    if not seen:
        print('watchdog: the config enables no watchdog driver')
    return faults


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: watchdog-nowayout-check.py <kernel-source> <.config> <exceptions|->')
    faults = main(*sys.argv[1:])
    for f in faults:
        print(f'error: {f}', file=sys.stderr)
    sys.exit(1 if faults else 0)
