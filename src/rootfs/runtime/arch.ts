// The Debian architectures Mica OS builds for, and what each one is to the readers that meet its files: the ELF
// class and machine of its binaries, its GNU triplet, the ld.so.cache flags of its glibc, the kernel image its
// boards boot, the FIT `arch` of that image and the docker platform of its images. It lives with the composition
// scripts, which run with nothing but this directory mounted, and the rest of the tree reads it from here.

export const ARCHES = ['amd64', 'arm64', 'armhf'] as const
export type Arch = typeof ARCHES[number]

export interface ArchFacts {
  /** EI_CLASS: 2 for 64-bit, 1 for 32-bit. */
  elfClass: 1 | 2
  /** e_machine: EM_X86_64, EM_AARCH64, EM_ARM. */
  elfMachine: number
  triplet: string
  /** An ld.so.cache 1.1 entry's flags: FLAG_ELF_LIBC6 with the architecture's library flag. */
  loaderCacheFlags: number
  /** The kernel image a board of the architecture builds, by the name the kernel's build gives it. */
  kernelImage: 'bzImage' | 'Image' | 'zImage'
  /** The FIT image node's `arch` (U-Boot's spelling); absent where no board boots a FIT. */
  fitArch?: 'arm64' | 'arm'
  platform: 'linux/amd64' | 'linux/arm64' | 'linux/arm/v7'
}

export const ARCH: Record<Arch, ArchFacts> = {
  amd64: { elfClass: 2, elfMachine: 62, triplet: 'x86_64-linux-gnu', loaderCacheFlags: 0x303, kernelImage: 'bzImage', platform: 'linux/amd64' },
  arm64: { elfClass: 2, elfMachine: 183, triplet: 'aarch64-linux-gnu', loaderCacheFlags: 0xa03, kernelImage: 'Image', fitArch: 'arm64', platform: 'linux/arm64' },
  armhf: { elfClass: 1, elfMachine: 40, triplet: 'arm-linux-gnueabihf', loaderCacheFlags: 0x903, kernelImage: 'zImage', fitArch: 'arm', platform: 'linux/arm/v7' },
}

export function isArch(value: unknown): value is Arch {
  return typeof value === 'string' && (ARCHES as readonly string[]).includes(value)
}

/** The architectures as an alternation, for usage lines and messages: `amd64|arm64|armhf`. */
export const ARCH_CHOICES = ARCHES.join('|')
