# Verifying a release directory

The documented verification commands, kept beside the code that
`build/src/release-manifest.test.ts` proves them with (the test extracts the
fenced block below and runs it); `mica:docs/design/release-artifacts.md`
explains the release directory they check.

<!-- release-verify-test:start -->
```bash
(cd "$RELEASE" && sha256sum -c SHA256SUMS)
bash "$REPO/build/run.sh" --release gate --dir "$RELEASE" --public-key "$METADATA_PUBLIC_KEY"
```
<!-- release-verify-test:end -->
