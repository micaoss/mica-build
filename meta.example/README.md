# `meta.example/` — public factory defaults

`meta.example/updates/manifest.json` is the committed example of the public
factory manifest baked into the read-only root. It contains configuration, not
signing material. Private signing inputs stay on their signing hosts, and
metadata trust anchors are fixed inputs to the authenticated kernel policy
rather than fields in this user-space manifest.

## Current manifest

The current JSON fields and committed example values are:

| JSON path | Example value | Meaning |
| --- | --- | --- |
| `schema` | `"mica/meta/v1"` | The only schema tag accepted by the current reader. |
| `product.vendor` | `"example"` | Product label. |
| `product.model` | `"mica-appliance"` | Product label. |
| `update.source` | `null` | No online update source is configured. |
| `update.channel` | `"stable"` | Default release channel. |
| `update.policy` | `"check"` | Check metadata on the configured interval; this is not `off`. |
| `update.checkIntervalMinutes` | `1440` | Metadata-check interval in minutes. |
| `http.credentialHosts` | `[]` | No additional host may receive update credentials. |
| `fleet.enabled` | `false` | Fleet integration is disabled. |
| `fleet.url` | `null` | No fleet endpoint is configured. |

All fields are required by the current `BakedManifest` shape, including the
nested fields, and unknown fields are refused by its parser. With
`update.source` set to `null`, there is no server to check or fetch from even
though the policy is `check`; offline import remains separate. Fleet is off and
has no endpoint.

If the baked file is missing, unreadable, invalid JSON, uses another schema, or
has an empty update channel, the current runtime reader records an error and
returns these code defaults: schema `mica/meta/v1`, empty product labels,
`source: null`, channel `stable`, policy `check`, interval `1440`, no credential
hosts, and fleet disabled with a null URL.

## Public root-build input

A product's `meta/` (`products/<name>/meta/`) is a public-only directory with this shape, and this directory is its committed example:

```text
updates/manifest.json
GENERATED                 # optional development-grade marker
```

Before staging, the root build validates the exact `mica/meta/v1` field set above
and permits only `updates/manifest.json` plus an optional `GENERATED` marker.
The supplied directory and its path components must not be symlinks;
`updates/` must be a non-symlink directory,
`updates/manifest.json` must be a nonempty regular non-symlink file, and
`GENERATED`, when present, must be a regular non-symlink file. The validator
rejects malformed UTF-8 or JSON, duplicate decoded field names, and invalid or
unexpected schema fields, and scans both permitted files for private material.
It then installs the manifest with mode 0644 and installs a nonempty `GENERATED`
marker with mode 0644; an absent or empty marker is not staged. This is
source-input validation, not packed-image or physical qualification.

No signing directory belongs in this distributed input. The root composer
receives only the public manifest and optional marker; boot, content, and
metadata signing keys remain on their respective signing hosts.

## Development signing inputs

Initialize the local signing directory with:

```sh
make os-keys-init
```

This defaults to the ignored `meta/` directory; set `MICA_SIGNING_OUTPUT` to
select another directory. Missing or empty directories receive new development
inputs. Repeated runs verify the existing private-key permissions, key types,
certificate validity and public/private pairing without changing identities.
Partial, mismatched or symlinked inputs are refused, not silently regenerated.
Initialization is serialized. Private material is never printed or committed.

Create an isolated set of development signing inputs with the existing
fresh-directory generator:

```sh
bash boot/dev-keys.sh --out /absolute/path/to/new-development-inputs
```

The `--out` directory must not already exist. The generator creates private
boot, content, and metadata signing inputs, their public counterparts, the
public manifest, and a `GENERATED` marker. Its complete output is private
signing-host material, not the directory distributed to root builders. Supply
root builders only the public-only shape above.

The authoritative custody and release rules remain in:

- [Key delivery](https://github.com/micaoss/mica/blob/main/docs/design/key-delivery.md)
- [Release artifacts](https://github.com/micaoss/mica/blob/main/docs/design/release-artifacts.md)
- [Release signing](https://github.com/micaoss/mica/blob/main/docs/design/release-signing.md)
- [Development input generator](../boot/dev-keys.sh)
