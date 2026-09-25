// The boot backends the engine implements: the one dispatch point on board.env's BOOT_BACKEND. A board that uses
// an existing backend is data; a new backend is one module registered here.
import type { Backend } from '../board-facts.ts'
import { systemdBoot } from './systemd-boot.ts'
import type { BootBackendModule } from './types.ts'
import { ubootFit } from './uboot-fit.ts'

export const BACKENDS: Readonly<Record<Backend, BootBackendModule>> = { 'systemd-boot': systemdBoot, 'uboot-fit': ubootFit }
export type { BootBackendModule } from './types.ts'
