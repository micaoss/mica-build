// What a boot backend is to the engine: the one place its facts are read, keyed by board.env's BOOT_BACKEND.
import type { Arch, BoardFacts, Profile } from '../board-facts.ts'

export interface BootBackendModule {
  /** The kernel component's boot object: its file, its component format and the packager's mode. */
  readonly bootFile: 'boot.efi' | 'boot.itb'
  readonly bootFormat: 'uki' | 'fit'
  readonly packMode: 'kernel' | 'fit'
  /** The packager image, for the board's EFI architecture where it has one. */
  packager(facts: BoardFacts): string
  /** The architecture the packaging tools run at. */
  toolsArch(arch: Arch): Arch
  /** The kernel directories of a board bundle, relative to it, and the one a profile packs. */
  readonly kernelDirs: readonly string[]
  kernelDir(profile: Profile): string
  /** Whether the board has a U-Boot component (its loader is built here). */
  readonly loaderComponent: boolean
  /** Whether the kernel's support image carries the board's firmware files and the regulatory database. */
  readonly supportFirmware: boolean
  /** The kernel symbols the backend's boot needs built in. */
  kernelSymbols(facts: BoardFacts): string[]
  /** The backend's own refusals of a kernel directory, before anything is packed. */
  verifyKernel(facts: BoardFacts, kernelDirectory: string, config: string, cmdline: string, profile: Profile): void
  /** What else the kernel's buildId covers, and what else the packager is given, from the kernel directory. */
  buildInputs(facts: BoardFacts, kernelDirectory: string): Record<string, unknown>
  stageBoot(facts: BoardFacts, kernelDirectory: string, input: string): void
}
