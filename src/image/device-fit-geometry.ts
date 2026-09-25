// The one place the engine knows a board by name, on purpose and for a limited time (tests/fixtures/board-name-lint.allow).
/**
 * The FIT record geometry mica-deploy compiles in, per board (mica-core crates/mica-deploy/src/fit_env.rs,
 * FitLayout): the records' offsets inside the firmware partition and its sector count, the partition at disk
 * sector 64. A FIT layout that differs is refused until the device reads the geometry from its signed board
 * policy (mica:docs/plan/20260921-1142-merge-boards-into-build.md, P4); this table is deleted with that task.
 */
export const DEVICE_FIT_GEOMETRY: Readonly<Record<string, { startSector: number, sizeSectors: number, records: readonly [number, number] }>> = {
  cx3576: { startSector: 64, sizeSectors: 36800, records: [16 * 1048576 - 32768, 17 * 1048576 - 32768] },
  s905x5m: { startSector: 64, sizeSectors: 262080, records: [120 * 1048576 - 32768, 124 * 1048576 - 32768] },
}
