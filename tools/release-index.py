#!/usr/bin/env python3
"""The Mica version index (mica/<YYYYMMDD-HHMM>): its lock and mica-index.json. Called by tools/release.sh index.

  release-index.py lock <history.tsv> <products.tsv> <stamp> <commit> <out lock>
      history.tsv: <release label> TAB <lock path> TAB <SHA256SUMS path>, newest first (tools/release.sh history)
      products.tsv: <product> TAB <board> TAB <profile> TAB <features> TAB <publish 0|1>
      The newest scoped release carrying each published product's row; its input, origin and built rows
      and the product, bundle and asset rows copied byte-for-byte. Refusals exit 3 naming their cause;
      a stamp not later than every reference and the previous index exits 4.
  release-index.py json <lock> <products.tsv> <boards.tsv> <layers.tsv> <assets.tsv> <downloads base> <out json>
      boards.tsv: <board> TAB <arch> TAB <release target 0|1> TAB <pinned boards release> TAB <its SHA256SUMS sha256>
      layers.tsv: <bundle reference> TAB <manifest path>
      assets.tsv: <release label> TAB <file> TAB <size>
"""
import hashlib
import json
import sys

KIND_ORDER = ['release', 'input', 'origin', 'built', 'index', 'product', 'bundle', 'asset']
KEY_WIDTH = {'input': 1, 'origin': 1, 'built': 2, 'index': 1, 'product': 1, 'bundle': 2, 'asset': 3}


def refuse(message, code=3):
    print(f'release-index: {message}', file=sys.stderr)
    sys.exit(code)


def rows_of(path):
    return [line.split('\t') for line in open(path).read().splitlines() if line and not line.startswith('#')]


def products_of(path):
    out = []
    for line in open(path).read().splitlines():
        if line:
            product, board, profile, features, publish = line.split('\t')
            out.append(dict(product=product, board=board, profile=profile, features=features.split(), publish=int(publish)))
    return out


def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def lock(history_path, products_path, stamp, commit, out):
    history = [line.split('\t') for line in open(history_path).read().splitlines() if line]
    scoped = [(label, rows_of(lock_path), sums) for label, lock_path, sums in history if not label.startswith('mica/')]
    indexes = [(label, rows_of(lock_path)) for label, lock_path, _ in history if label.startswith('mica/')]
    selected = {}
    for p in products_of(products_path):
        if not p['publish']:
            continue
        for label, rows, sums in scoped:
            if any(r[0] == 'product' and r[1] == p['product'] for r in rows):
                selected[p['product']] = (label, rows, sums)
                break
    if not selected:
        refuse('no published product has a scoped release; there is nothing to index')
    by_scope = {}
    for product, (label, _, _) in selected.items():
        scope = label.split('/')[0]
        if by_scope.setdefault(scope, label) != label:
            refuse(f'products of the scope {scope} come from two releases, {by_scope[scope]} and {label}; one input names one release of a scope')
    # The previous index: generations never go down.
    if indexes:
        previous_label, previous = indexes[0]
        before = {r[1]: int(r[4]) for r in previous if r[0] == 'product'}
        for product, (label, rows, _) in selected.items():
            generation = next(int(r[4]) for r in rows if r[0] == 'product' and r[1] == product)
            if product in before and generation < before[product]:
                refuse(f'{product}: generation {generation} of {label} is lower than {before[product]} in the previous index {previous_label}')
    newest = max([label.split('/')[1] for label, _, _ in selected.values()] + [label.split('/')[1] for label, _ in indexes[:1]])
    if not stamp > newest:
        refuse(f'the stamp {stamp} is not later than {newest}', code=4)
    lines = [['release', 'mica-build', f'mica/{stamp}', commit]]
    for label, rows, sums in {v[0]: v for v in selected.values()}.values():
        scope, release = label.split('/')
        name = f'mica-build.{scope}'
        lines.append(['input', name, release, sha256(sums)])
        lines.append(['origin', name, rows[0][3]])
        lines += [['built', name] + r[1:] for r in rows if r[0] == 'input']
    for product, (label, rows, _) in selected.items():
        lines.append(['index', product, 'mica-build.' + label.split('/')[0]])
        lines += [r for r in rows if r[0] in ('product', 'bundle', 'asset') and r[1] == product]
    head, body = lines[0], lines[1:]
    body.sort(key=lambda r: (KIND_ORDER.index(r[0]),) + tuple(k.encode() for k in r[1:1 + KEY_WIDTH[r[0]]]))
    open(out, 'w').write('# mica-lock v1\n' + ''.join('\t'.join(r) + '\n' for r in [head] + body))


def render(lock_path, products_path, boards_path, layers_path, assets_path, downloads, out):
    rows = rows_of(lock_path)
    release = rows[0]
    stamp = release[2].split('/')[1]
    manifests = {}
    for line in open(layers_path).read().splitlines():
        if line:
            reference, path = line.split('\t')
            manifests[reference] = json.load(open(path))
    sizes = {}
    for line in open(assets_path).read().splitlines():
        if line:
            label, file, size = line.split('\t')
            sizes[(label, file)] = int(size)
    inputs = {r[1]: r for r in rows if r[0] == 'input'}
    label_of = lambda name: name.split('.', 1)[1] + '/' + inputs[name][2]
    releases = []
    for name in sorted(inputs, key=label_of):
        built = []
        for r in rows:
            if r[0] == 'built' and r[1] == name:
                repository, _, scope = r[2].partition('.')
                entry = dict(repository=repository)
                if scope:
                    entry['scope'] = scope
                built.append(dict(entry, release=r[3], trust=r[4]))
        releases.append(dict(release=label_of(name), trust=inputs[name][3],
                             commit=next(r[2] for r in rows if r[0] == 'origin' and r[1] == name), inputs=built))
    indexed = {r[1]: label_of(r[2]) for r in rows if r[0] == 'index'}
    products = []
    for p in sorted(indexed):
        label = indexed[p]
        _, _, board, profile, generation, deployment, kernel, rootfs = next(r for r in rows if r[0] == 'product' and r[1] == p)
        bundles = {kind: next(r[3] for r in rows if r[0] == 'bundle' and r[1] == p and r[2] == kind) for kind in ('image', 'update')}
        entry = dict(product=p, board=board, profile=profile, generation=int(generation), deployment=deployment, kernel=kernel,
                     rootfs=rootfs, release=label, bundles=bundles, images=[], updates=[])
        for r in rows:
            if r[0] != 'asset' or r[1] != p:
                continue
            _, _, kind_type, kind, file, digest = r
            layers = [layer for layer in manifests[bundles[kind_type]]['layers'] if layer['digest'] == 'sha256:' + digest]
            if len(layers) != 1:
                refuse(f'{file}: the {kind_type} bundle of {p} holds no single layer sha256:{digest}')
            layer = layers[0]
            size = sizes[(label, file)]
            if layer['size'] != size:
                refuse(f'{file}: the release asset is {size} bytes and its layer {layer["size"]}')
            item = dict(kind=kind, file=file, url=f'{downloads}/{label}/{file}', sha256=digest, size=size)
            annotations = layer.get('annotations', {})
            if kind_type == 'image':
                if annotations.get('mica.compression') == 'gzip':
                    item.update(compression='gzip', uncompressedSha256=annotations['mica.uncompressed-sha256'],
                                uncompressedSize=int(annotations['mica.uncompressed-size']))
                else:
                    item.update(compression='none', uncompressedSha256=digest, uncompressedSize=size)
                entry['images'].append(item)
            else:
                requires = dict(generationBelow=int(generation))
                if kind == 'root':
                    requires['kernel'] = kernel
                if kind == 'kernel':
                    requires['rootfs'] = rootfs
                item['requires'] = requires
                entry['updates'].append(item)
        entry['images'].sort(key=lambda i: i['kind'])
        entry['updates'].sort(key=lambda i: i['kind'])
        products.append(entry)
    boards = []
    for line in open(boards_path).read().splitlines():
        if line:
            board, arch, target, pinned, trust = line.split('\t')
            boards.append(dict(board=board, arch=arch, releaseTarget=target == '1', pinnedBoardsRelease=dict(release=pinned, trust=trust)))
    catalogue_products = [dict(product=p['product'], board=p['board'], profile=p['profile'], features=p['features'],
                               publish=p['publish'], indexed=p['product'] in indexed) for p in products_of(products_path)]
    document = dict(schema='mica/index/v1', version=stamp, commit=release[3],
                    lock=dict(file='mica-build.lock', sha256=sha256(lock_path)), releases=releases, products=products,
                    catalogue=dict(boards=sorted(boards, key=lambda b: b['board']), products=sorted(catalogue_products, key=lambda p: p['product'])))
    # Canonical JSON (docs/design/mica-index.md section 2): keys in the order of the shape, built above.
    open(out, 'w').write(json.dumps(document, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    if len(sys.argv) == 7 and sys.argv[1] == 'lock':
        lock(*sys.argv[2:])
    elif len(sys.argv) == 9 and sys.argv[1] == 'json':
        render(*sys.argv[2:])
    else:
        refuse('usage: release-index.py lock ... | json ...', code=2)
