// The partition roles the engine implements, the one dispatch point on a partition's role: layout.tsv names a
// role per partition and the assembly calls ROLES[role]. A new role is one module registered here; the
// board contract test refuses a declared role no registry carries (ROLE_NAMES, src/image/file-layout.ts).
import type { Role } from '../file-layout.ts'
import type { RoleBuilder } from './context.ts'
import { data } from './data.ts'
import { esp } from './esp.ts'
import { ext4 } from './ext4.ts'
import { raw } from './raw.ts'
import { system } from './system.ts'
import { vfat } from './vfat.ts'

export const ROLES: Readonly<Record<Role, RoleBuilder>> = { esp, system, data, raw, vfat, ext4 }
export type { RoleContext } from './context.ts'
