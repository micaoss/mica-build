// Timeouts for the tests that drive real tools, and why they are not the default.
//
// bun's default per-test and per-hook timeout is 5 s, which is right for a
// suite that computes and wrong for one that starts containers. Measured on
// this host, 2026-08-25:
//
//   Toolbox.open, host route                      ~4 ms
//   Toolbox.open, alpine + apk (assembly toolset) ~2.1 s
//   Toolbox.open, alpine + apk coreutils          ~4.6 s
//   Toolbox.open, pinned component tooling     ~7-40 s
//   one docker exec into an open toolbox          ~40 ms
//   one docker run --rm (what a session avoids)   ~320 ms
//
// The 4.6 s open is the one that matters: it is UNDER the default and it flaked
// against it, which is the worst kind of limit -- green on a warm image cache
// and red on a cold one, for a reason that has nothing to do with what is being
// tested. So the tests that open a toolbox say so with a number, at the place
// that pays the cost, rather than the whole suite being given a blanket flag
// that would also hide a genuine hang in the tests that compute.
//
// These are CEILINGS, not budgets. The whole suite runs in well under a minute
// of tool time on a warm cache; what they buy is that a cold pull or a slow
// registry is a slow run rather than a red one.

/** For a hook that opens one or more toolboxes: an image may have to be pulled. */
export const OPEN_TIMEOUT_MS = 300_000

/**
 * For a test that drives real tools through a toolbox a hook already opened,
 * and for the teardown that removes it.
 *
 * 300 s since 2026-08-31, up from 120 s. Measured that day outside the harness,
 * at load 9.6 on 8 cores, over the debian:trixie-slim path these tests drive:
 *
 *   container creation   17,028 / 80,528 / 101,693 ms  (quiet baseline ~320 ms)
 *   apt install gdisk                       11,360 ms
 *   docker exec round-trip                       47 ms (quiet baseline ~40 ms)
 *
 * Creation is what degrades first, by up to ~300x. Exec is normally ~47 ms, but
 * the daemon kept degrading during the measurement itself: in the worst case a
 * first exec was still outstanding after five minutes. So nothing here is a
 * bound. 300 s is SIZED -- it covers the largest measured creation plus the
 * work with margin, and takes the observed 120,001 ms failure (an mkimage-uefi
 * sgdisk case, whose exact mechanism is not pinned: it execs against an
 * already-open toolbox, so creation cost alone does not explain it) as a lower
 * bound. If a test still trips this ceiling under load, that is evidence
 * against the sizing and worth reporting, not noise to be absorbed by raising
 * it again.
 *
 * The same number as OPEN_TIMEOUT_MS one shelf up, for a neighbouring reason:
 * that one is 300 s because an image may have to be pulled, this one because
 * the container work behind these tests -- starting one, driving it, removing
 * it -- happens on a host that may be loaded.
 */
export const TOOL_TIMEOUT_MS = 300_000
