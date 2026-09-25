// systemd-boot: a signed UKI on the esp, one kernel directory whose profile is on the signed command line.
import type { BootBackendModule } from './types.ts'

const BOOT_TOOLS = { X64: 'ai-agent/mica-boot-tools-amd64', AA64: 'ai-agent/mica-boot-tools-arm64' } as const

export const systemdBoot: BootBackendModule = {
  bootFile: 'boot.efi',
  bootFormat: 'uki',
  packMode: 'kernel',
  packager: facts => BOOT_TOOLS[facts.efiArch],
  toolsArch: arch => arch,
  kernelDirs: ['kernel'],
  kernelDir: () => 'kernel',
  loaderComponent: false,
  supportFirmware: false,
  kernelSymbols: () => ['EFI_STUB', 'I6300ESB_WDT'],
  verifyKernel: () => {},
  buildInputs: () => ({}),
  stageBoot: () => {},
}
