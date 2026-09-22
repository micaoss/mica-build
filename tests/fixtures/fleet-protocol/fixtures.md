# Fleet protocol design evidence

Normative contract: [protocol plan](https://github.com/micaoss/mica/blob/main/docs/plan/20260910-1910-fleet-device-plane-protocol.md).
This directory contains no device client, plane server or production module.

Run from repository root with the already pinned tool image; no installation:

```bash
mica-build-env:base="$(bash tools/from.sh --ref mica-build-env:base)"
timeout 30s docker run --rm --pull=never --label ai-agent=true \
  --network none -v "$PWD:$PWD:ro" -w "$PWD" \
  "$mica-build-env:base" bun tests/fixtures/fleet-protocol/validate.mjs
```

The workspace here is under `/srv`, identical on host/container. Translate
`/work` or `/root` before using the command from another checkout.

`exchanges.json` provides eight separate successful HTTP exchanges, not a
single chronological session. Each has an explicit HTTP/1.1 envelope with
origin-matching Host, optional User-Agent and Connection. Body bytes use the plan's compact sorted-key
encoding; header values and Content-Length are explicit. Signatures consisting
of zeroes are intentionally invalid shape placeholders. Stored raw header
fixtures use repository LF endings; their check covers duplicate/unknown header
names, not a production HTTP framing parser. The complete bounded envelope
check uses the same decoded-pair normalization as the raw duplicate fixture;
it rejects duplicates before building the canonical-name `$defs.headers` map.
That schema includes all allowed ordinary request headers. HTTP/2 controls
pass lowercase ordinary fields plus the four ordered `pseudoHeaders` pairs;
`httpVersion` is fixture metadata. This checks decoded values, singleton/count/
byte limits and origin/method/path consistency. It cannot prove raw HTTP/2
pseudo-header ordering, HPACK bounds or real HTTP framing. Public keys are public
example bytes, never a registry entry or evidence of authorization. The example
origin is a placeholder and no HTTP connection is made. The in-memory Ed25519
controls generate fresh ephemeral keys, verify mutation refusal and write no
key material to disk.

`protocol.schema.json` defines the entire v1 wire shape. `register.json`,
`report.json` and `reports.json` retain benign rich/null examples. The evaluator
checks every schema keyword used here and refuses unsupported vocabulary;
u64 upper bounds, byte limits, order and cross-field rules are additional
semantic checks, not claims that JSON Schema proves authorization. Raw
`duplicate-*.json`, `duplicate-header.http` and `malformed.json` must be parsed
without overwriting duplicate members. `negative-cases.json` gives the
normative section and expected refusal for each data mutation. There are
positive controls for each endpoint, parsing, signature and state model.

`MODEL` results use symbolic verified principals and in-memory candidate
transactions. They illustrate expected authorization, ownership, key overlap,
queue pressure and counter behavior; they prove no runtime fsync, TLS, access
control deployment or integration with today's source. Date/retry checks use
fixed clocks and deterministic jitter inputs. The later runtime, interop,
restored-server and board acceptance matrix is in N9 of the plan.

The runner prints per-file SHA-256 identities after successful verification.
An optional single check-name substring argument selects a focused run, for
example `bun tests/fixtures/fleet-protocol/validate.mjs 'repair1 P1'`; zero matching checks
fail. Omit it for the complete gate. Repair 1 first ran wrong-device and
wrong-role receipt controls and the permitted HTTP/1.1 envelope against the
unfixed model/schema; their actual failures and subsequent GREEN are recorded
separately from the original 46-check history. Receipt recovery keeps its
special old-key permission after report overlap expires, but requires the
same device role/ID, current generation/epoch, old key, request ID, next key
and exact body digest; rejection must not mutate the modeled row.
The task records actual command logs and source identity. Malformed fixtures
are intentional and are never sent to a live service.
