// uboot-fit: a signed FIT on SYSTEM, loaded by the board's own U-Boot; the kernel forces its built-in command line,
// which carries the profile, so a bundle has one kernel directory per profile.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactFile } from '../component-build.ts'
import { validateFitKernel } from '../fit-board.ts'
import type { BoardFacts } from '../board-facts.ts'
import type { BootBackendModule } from './types.ts'

const fitOf = (facts: BoardFacts) => {
  if (facts.fit === undefined) throw new Error(`${facts.board} declares BOOT_BACKEND=uboot-fit and no FIT facts`)
  return facts.fit
}

export const ubootFit: BootBackendModule = {
  bootFile: 'boot.itb',
  bootFormat: 'fit',
  packMode: 'fit',
  packager: () => 'ai-agent/mica-fit-tools-amd64',
  // The FIT packaging tools are linux/amd64 on every board.
  toolsArch: () => 'amd64',
  kernelDirs: ['kernel/dev', 'kernel/prod'],
  kernelDir: profile => `kernel/${profile}`,
  loaderComponent: true,
  supportFirmware: true,
  kernelSymbols: facts => [fitOf(facts).watchdog, 'CMDLINE_FORCE'],
  verifyKernel(facts, kernelDirectory, config, cmdline, profile) {
    // A FIT kernel forces its built-in command line (CMDLINE_FORCE), so the profile token is part of the kernel
    // the board builds for that profile. The refusal prints BOTH lines: a permanently red job is read by people
    // deciding whether it is NEW, not by people debugging it.
    if (!config.split('\n').includes(`CONFIG_CMDLINE="${cmdline}"`)) {
      const built = config.split('\n').find(line => line.startsWith('CONFIG_CMDLINE=')) ?? '<the config carries no CONFIG_CMDLINE line at all>'
      throw new Error(`FIT kernel command policy differs from authenticated packaging: the ${profile} kernel must be built with CONFIG_CMDLINE="${cmdline}"\n`
        + `  the kernel in this bundle was built with: ${built}\n`
        + `  The required line is ${facts.board}'s own BOARD_CMDLINE_ARGS plus the profile token, so a divergence is INSIDE one board release: its declaration and its kernel disagree. CMDLINE_FORCE means the built-in line is the one the device boots with, and nothing downstream can add the missing tokens.\n`
        + `  This refusal is correct for as long as the bundle is inconsistent. A consumer pins RELEASES: a repair on the board repository's main does not reach here until it is released and locks/pins/ moves, so this stays red until then -- check the pinned release, not the board's branch, before reading it as new.`)
    }
    const fit = fitOf(facts)
    const image = readFileSync(join(kernelDirectory, facts.kernelImage))
    validateFitKernel(fit.addresses, image.subarray(0, 64), image.length, artifactFile(join(kernelDirectory, fit.dtb)).bytes)
  },
  buildInputs: (facts, kernelDirectory) => ({ dtb: artifactFile(join(kernelDirectory, fitOf(facts).dtb)), addresses: fitOf(facts).addresses }),
  stageBoot(facts, kernelDirectory, input) {
    const fit = fitOf(facts)
    copyFileSync(join(kernelDirectory, fit.dtb), join(input, 'board.dtb'))
    writeFileSync(join(input, 'fit-addresses'), `${fit.addresses.join(' ')}\n`)
  },
}
