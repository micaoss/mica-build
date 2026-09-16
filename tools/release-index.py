#!/usr/bin/env python3
"""The Mica version index (mica.<YYYYMMDD-HHMM>): its lock and mica-index.json. Called by tools/release.sh index.

  release-index.py lock <history.tsv> <products.tsv> <stamp> <commit> <full|incremental> <out lock> <out entering.tsv>
      history.tsv: <release label> TAB <lock path> TAB <SHA256SUMS path>, newest first (tools/release.sh history);
          an index's mica-index.json sits beside its lock
      products.tsv: <product> TAB <board> TAB <profile> TAB <features> TAB <publish 0|1>
      full: the newest scoped release of the history carrying each published product. incremental: the entries of
      the newest index of the history carried unread, a newer scoped release of the history entering or replacing
      entries, and the entry of a product no longer published dropped. A previous index bounds the stamp and the
      generations either way. entering.tsv: <product> TAB <release label> of every entry not carried.
      Refusals exit 3 naming their cause, a stamp not later than every reference and the previous index exits 4,
      and an incremental index into which nothing enters and from which nothing is dropped exits 5.
  release-index.py json <lock> <history.tsv> <entering.tsv> <products.tsv> <boards.tsv> <layers.tsv> <assets.tsv> <downloads base> <mirrors.list|-> <out json>
      boards.tsv: <board> TAB <arch> TAB <release target 0|1> TAB <pinned boards release> TAB <its SHA256SUMS sha256>
      layers.tsv: <bundle reference> TAB <manifest path>, of the entering entries
      assets.tsv: <release label> TAB <file> TAB <size>, of the entering entries
      The previous index's mica-index.json is first proved to be its lock's; a carried entry is its entry there.
      mirrors.list holds one absolute https base per line, in the order a reader should try them; each file's
      mirrors are derived as <base>/d/mica/<scope>/<stamp>/<file> and the member is omitted where there is none.
"""
import hashlib
import json
import os
import sys

KIND_ORDER = ['release', 'input', 'origin', 'built', 'index', 'product', 'bundle', 'asset']
KEY_WIDTH = {'input': 1, 'origin': 1, 'built': 2, 'index': 1, 'product': 1, 'bundle': 2, 'asset': 3}
LAYER_FIELDS = ('size', 'compression', 'uncompressedSha256', 'uncompressedSize')


def mirror_bases(path):
    """The committed mirror bases, in file order: a preference list, never sorted (mica-index.md 3.1)."""
    if path == '-' or not os.path.exists(path):
        return []
    bases = [line.strip() for line in open(path).read().splitlines()]
    bases = [b for b in bases if b and not b.startswith('#')]
    for b in bases:
        if not b.startswith('https://') or b.rstrip('/') != b:
            refuse(f'{path}: {b!r} is no absolute https base without a trailing slash')
    if len(set(bases)) != len(bases):
        refuse(f'{path}: a base is named twice; each mirror appears once')
    return bases


def mirrors_of(bases, label, file, url):
    """The mirrors of one file, derived and never looked up; the member is omitted where the list is empty."""
    scope, stamp = label.split('.', 1)
    entries = [f'{base}/d/mica/{scope}/{stamp}/{file}' for base in bases]
    if any(e == url for e in entries):
        refuse(f'{file}: a mirror equals its url {url}, which is the source the reader already has')
    return entries


def refuse(message, code=3):
    print(f'release-index: {message}', file=sys.stderr)
    sys.exit(code)


def rows_of(path):
    return [line.split('\t') for line in open(path).read().splitlines() if line and not line.startswith('#')]


def tsv(path):
    return [line.split('\t') for line in open(path).read().splitlines() if line]


def products_of(path):
    return [dict(product=product, board=board, profile=profile, features=features.split(), publish=publish == '1')
            for product, board, profile, features, publish in tsv(path)]


def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def stamp_of(label):
    """The stamp of a release tag <scope>.<YYYYMMDD-HHMM>; a scope holds no dot."""
    return label.split('.', 1)[1]


def history_of(path):
    history = [dict(label=label, rows=rows_of(lock_path), lock=lock_path, sums=sums) for label, lock_path, sums in tsv(path)]
    indexes = [h for h in history if h['label'].startswith('mica.')]
    return [h for h in history if not h['label'].startswith('mica.')], (indexes[0] if indexes else None)


def input_label(rows, name):
    """The scoped release label that the input <name> of an index lock names."""
    return name.split('.', 1)[1] + '.' + next(r[2] for r in rows if r[0] == 'input' and r[1] == name)


def lock(history_path, products_path, stamp, commit, mode, out, entering_out):
    scoped, previous = history_of(history_path)
    published = [p['product'] for p in products_of(products_path) if p['publish']]
    # product -> (label, source): a source is a scoped release, or the previous index for a carried entry.
    entries, carried, dropped = {}, set(), []
    if mode == 'incremental':
        if previous is None:
            refuse('an incremental index needs a previous index')
        for r in previous['rows']:
            if r[0] != 'index':
                continue
            if r[1] in published:
                entries[r[1]] = (input_label(previous['rows'], r[2]), previous)
                carried.add(r[1])
            else:
                dropped.append(r[1])
    for product in published:
        for release in scoped:
            if any(r[0] == 'product' and r[1] == product for r in release['rows']):
                if product not in entries or stamp_of(release['label']) > stamp_of(entries[product][0]):
                    entries[product] = (release['label'], release)
                    carried.discard(product)
                break
    if not entries:
        # No scoped release exists yet (the tag form changed, or nothing is released): there is nothing to index,
        # which is not a refusal -- the caller returns without cutting one.
        refuse('no published product has a scoped release; there is nothing to index', code=5)
    by_scope = {}
    for product, (label, _) in sorted(entries.items()):
        scope = label.split('.', 1)[0]
        if by_scope.setdefault(scope, label) != label:
            refuse(f'products of the scope {scope} come from two releases, {by_scope[scope]} and {label}; one input names one release of a scope')
    if previous:
        before = {r[1]: int(r[4]) for r in previous['rows'] if r[0] == 'product'}
        for product, (label, source) in sorted(entries.items()):
            generation = next(int(r[4]) for r in source['rows'] if r[0] == 'product' and r[1] == product)
            if product in before and generation < before[product]:
                refuse(f'{product}: generation {generation} of {label} is lower than {before[product]} in the previous index {previous["label"]}')
    newest = max([stamp_of(label) for label, _ in entries.values()] + ([stamp_of(previous['label'])] if previous else []))
    if not stamp > newest:
        refuse(f'the stamp {stamp} is not later than {newest}', code=4)
    if mode == 'incremental' and not dropped and carried == set(entries):
        refuse(f'nothing enters or leaves the previous index {previous["label"]}', code=5)
    lines = [['release', 'mica-build', f'mica.{stamp}', commit]]
    for label, source in dict(entries.values()).items():
        name = 'mica-build.' + label.split('.', 1)[0]
        if source is previous:
            lines += [r for r in previous['rows'] if r[0] in ('input', 'origin', 'built') and r[1] == name]
        else:
            lines.append(['input', name, stamp_of(label), sha256(source['sums'])])
            lines.append(['origin', name, source['rows'][0][3]])
            lines += [['built', name] + r[1:] for r in source['rows'] if r[0] == 'input']
    for product, (label, source) in entries.items():
        lines.append(['index', product, 'mica-build.' + label.split('.', 1)[0]])
        lines += [r for r in source['rows'] if r[0] in ('product', 'bundle', 'asset') and r[1] == product]
    trusts = {}
    for r in lines:
        if r[0] == 'built' and trusts.setdefault((r[2], r[3]), r[4]) != r[4]:
            refuse(f'the input {r[2]} {r[3]} has the trust hash {trusts[(r[2], r[3])]} in one release and {r[4]} in another')
    head, body = lines[0], lines[1:]
    body.sort(key=lambda r: (KIND_ORDER.index(r[0]),) + tuple(k.encode() for k in r[1:1 + KEY_WIDTH[r[0]]]))
    open(out, 'w').write('# mica-lock v1\n' + ''.join('\t'.join(r) + '\n' for r in [head] + body))
    open(entering_out, 'w').write(''.join(f'{p}\t{entries[p][0]}\n' for p in sorted(entries) if p not in carried))
    for product in sorted(dropped):
        print(f'release-index: {product} is no longer published; its entry is dropped', file=sys.stderr)


def lock_parts(rows, lock_sha, downloads, bases):
    """Everything of mica-index.json the lock alone determines; the layer fields of a product's files are None."""
    release = rows[0]
    inputs, releases = {}, []
    for name in sorted((r[1] for r in rows if r[0] == 'input'), key=lambda n: input_label(rows, n)):
        ids = []
        for r in rows:
            if r[0] == 'built' and r[1] == name:
                repository, _, scope = r[2].partition('.')
                # The id keeps its slash: it joins a built name to a release, it is no git tag (mica-index.md 3.1).
                entry = dict(id=f'{r[2]}/{r[3]}', repository=repository)
                if scope:
                    entry['scope'] = scope
                inputs[entry['id']] = dict(entry, release=r[3], trust=r[4])
                ids.append(entry['id'])
        releases.append(dict(release=input_label(rows, name), trust=next(r[3] for r in rows if r[0] == 'input' and r[1] == name),
                             commit=next(r[2] for r in rows if r[0] == 'origin' and r[1] == name), inputs=sorted(ids)))
    products = {}
    for index_row in (r for r in rows if r[0] == 'index'):
        product, label = index_row[1], input_label(rows, index_row[2])
        _, _, board, profile, generation, deployment, kernel, rootfs = next(r for r in rows if r[0] == 'product' and r[1] == product)
        bundles = {kind: next(r[3] for r in rows if r[0] == 'bundle' and r[1] == product and r[2] == kind) for kind in ('image', 'update')}
        entry = dict(product=product, board=board, profile=profile, generation=int(generation), deployment=deployment, kernel=kernel,
                     rootfs=rootfs, release=label, bundles=bundles, images=[], updates=[])
        for _, _, kind_type, kind, file, digest in (r for r in rows if r[0] == 'asset' and r[1] == product):
            url = f'{downloads}/{label}/{file}'
            item = dict(kind=kind, file=file, url=url)
            mirrors = mirrors_of(bases, label, file, url)
            if mirrors:
                item['mirrors'] = mirrors
            item.update(sha256=digest, size=None)
            if kind_type == 'image':
                item.update(compression=None, uncompressedSha256=None, uncompressedSize=None)
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
        products[product] = entry
    header = dict(schema='mica/index/v1', version=stamp_of(release[2]), commit=release[3], lock=dict(file='mica-build.lock', sha256=lock_sha))
    return header, [inputs[i] for i in sorted(inputs)], releases, products


def remirrored(item, bases, label):
    """One file's entry with its mirrors derived afresh, keeping the member's place right after url."""
    out = {}
    for key, value in item.items():
        if key == 'mirrors':
            continue
        out[key] = value
        if key == 'url':
            mirrors = mirrors_of(bases, label, item['file'], item['url'])
            if mirrors:
                out['mirrors'] = mirrors
    return out


def without_layer_fields(entry, reference=None):
    """An entry reduced to what the lock alone determines. A file of <reference> that carries no mirrors drops
    them from the comparison too: an index cut before the mirror base was committed has none, and carrying its
    entries forward is not a mismatch. A file that DOES carry them must carry the derived ones, so a tampered
    mirrors member cannot be carried into a new index."""
    def files(items, others):
        out = []
        for i, item in enumerate(items):
            item = {k: v for k, v in item.items() if k not in LAYER_FIELDS}
            if others is not None and i < len(others) and 'mirrors' not in others[i]:
                item.pop('mirrors', None)
            out.append(item)
        return out
    return dict(entry, images=files(entry['images'], reference and reference['images']),
                updates=files(entry['updates'], reference and reference['updates']))


def previous_entries(previous, downloads, bases):
    """The previous index's product entries, once its mica-index.json is proved to be its lock's."""
    label = previous['label']
    try:
        document = json.load(open(os.path.join(os.path.dirname(previous['lock']), 'mica-index.json')))
        header, inputs, releases, products = lock_parts(previous['rows'], sha256(previous['lock']), downloads, bases)
        listed = {p['product']: p for p in document['products']}
        consistent = (all(document[k] == v for k, v in header.items()) and document['inputs'] == inputs and document['releases'] == releases
                      and [p['product'] for p in document['products']] == sorted(products)
                      and all(without_layer_fields(listed[p]) == without_layer_fields(products[p], listed[p]) for p in products))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration) as error:
        refuse(f'the previous index {label}: its mica-index.json cannot be read against its lock ({error!r})')
    if not consistent:
        refuse(f'the previous index {label}: its mica-index.json does not match its mica-build.lock')
    return listed


def render(lock_path, history_path, entering_path, products_path, boards_path, layers_path, assets_path, downloads, mirrors_path, out):
    rows = rows_of(lock_path)
    bases = mirror_bases(mirrors_path)
    _, previous = history_of(history_path)
    carried_entries = previous_entries(previous, downloads, bases) if previous else {}
    entering = dict(tsv(entering_path))
    manifests = {reference: json.load(open(path)) for reference, path in tsv(layers_path)}
    sizes = {(label, file): int(size) for label, file, size in tsv(assets_path)}
    header, inputs, releases, products = lock_parts(rows, sha256(lock_path), downloads, bases)
    for product, entry in products.items():
        if product not in entering:
            if carried_entries.get(product, {}).get('release') != entry['release']:
                refuse(f'{product}: its entry of {entry["release"]} is neither entering nor carried from the previous index')
            # A carried entry keeps every field it was read with, except its mirrors, which are DERIVED and so are
            # re-derived here: an entry carried from an index cut before this base was committed would otherwise
            # keep no mirrors while an entering one has them, and --full, which re-derives every entry, would
            # disagree with the index it is verifying.
            products[product] = carried = dict(carried_entries[product])
            for kind_type in ('images', 'updates'):
                carried[kind_type] = [remirrored(item, bases, carried['release']) for item in carried[kind_type]]
            continue
        for kind_type, items in (('image', entry['images']), ('update', entry['updates'])):
            for item in items:
                file, digest = item['file'], item['sha256']
                if entry['bundles'][kind_type] not in manifests:
                    refuse(f'{product}: its {kind_type} bundle {entry["bundles"][kind_type]} was not read')
                layers = [layer for layer in manifests[entry['bundles'][kind_type]]['layers'] if layer['digest'] == 'sha256:' + digest]
                if len(layers) != 1:
                    refuse(f'{file}: the {kind_type} bundle of {product} holds no single layer sha256:{digest}')
                if (entry['release'], file) not in sizes:
                    refuse(f'{file}: no asset of release {entry["release"]} was read')
                size = sizes[(entry['release'], file)]
                if layers[0]['size'] != size:
                    refuse(f'{file}: the release asset is {size} bytes and its layer {layers[0]["size"]}')
                item['size'] = size
                if kind_type == 'image':
                    annotations = layers[0].get('annotations', {})
                    if annotations.get('mica.compression') == 'gzip':
                        item.update(compression='gzip', uncompressedSha256=annotations['mica.uncompressed-sha256'],
                                    uncompressedSize=int(annotations['mica.uncompressed-size']))
                    else:
                        item.update(compression='none', uncompressedSha256=digest, uncompressedSize=size)
    boards = [dict(board=board, arch=arch, releaseTarget=target == '1', pinnedBoardsRelease=dict(release=pinned, trust=trust))
              for board, arch, target, pinned, trust in tsv(boards_path)]
    document = dict(header)
    if previous:
        document['previous'] = dict(release=previous['label'], trust=sha256(previous['sums']))
    document.update(inputs=inputs, releases=releases, products=[products[p] for p in sorted(products)],
                    catalogue=dict(boards=sorted(boards, key=lambda b: b['board']),
                                   products=sorted((dict(p, indexed=p['product'] in products) for p in products_of(products_path)), key=lambda p: p['product'])))
    # Canonical JSON (mica:docs/design/mica-index.md section 2): keys in the order of the shape, built above.
    open(out, 'w').write(json.dumps(document, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    if len(sys.argv) == 9 and sys.argv[1] == 'lock' and sys.argv[6] in ('full', 'incremental'):
        lock(*sys.argv[2:])
    elif len(sys.argv) == 12 and sys.argv[1] == 'json':
        render(*sys.argv[2:])
    else:
        refuse('usage: release-index.py lock ... | json ...', code=2)
