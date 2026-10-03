# Verifying a release directory

The documented verification commands, kept beside the code that
`src/image/release-manifest.test.ts` proves them with (the test extracts the
fenced block below and runs it); `mica:docs/design/release-artifacts.md`
explains the release directory they check.

<!-- release-verify-test:start -->
```bash
(cd "$RELEASE" && sha256sum -c SHA256SUMS)
bash "$REPO/bin/bun.sh" src/cli.ts release gate --dir "$RELEASE" --public-key "$METADATA_PUBLIC_KEY"
```
<!-- release-verify-test:end -->
