import type { BoardFacts } from './board-facts.ts'
import type { Artifact } from './components.ts'
import { authenticatePayload, canonicalJson, componentId } from './components.ts'
import { FIRMWARE_FORMATS, type FirmwareFormatModule, type FirmwareTarget } from './firmware-formats.ts'

export interface Firmware {
  schema: 'mica/firmware/v1'
  id: string
  board: string
  arch: 'amd64' | 'arm64'
  generation: number
  version: string
  artifact: Artifact
  // The numbers are the board's (the loader region of its layout.tsv, board.env's UBOOT_MAX_BYTES,
  // UBOOT_PAYLOAD_OFFSET_BYTES); parseFirmware holds a manifest to them when it is given the board's facts.
  target: FirmwareTarget
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid firmware contract: ${message}`)
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  const record = value as Record<string, unknown>
  requireValue(Object.keys(record).sort().join() === fields.sort().join(), 'unknown or missing fields')
  return record
}

/** The target a board's firmware is written to, from its facts. */
export function firmwareTarget(facts: BoardFacts): Firmware['target'] {
  return FIRMWARE_FORMATS[facts.firmware.format].target(facts.firmware)
}

/**
 * Parse a firmware manifest. Without facts the SHAPE is judged: a target of
 * one of the three formats, bounded. With the facts of a board, the manifest
 * must be that board's -- its name, its architecture and exactly the target
 * board.env states -- which is what the assembler and the verifier ask.
 */
export function parseFirmware(payload: string, facts?: BoardFacts): Firmware {
  requireValue(Buffer.byteLength(payload) <= 4096, 'manifest exceeds limit')
  const value: unknown = JSON.parse(payload)
  requireValue(canonicalJson(value) === payload, 'noncanonical or duplicate fields')
  const firmware = object(value, ['schema', 'id', 'board', 'arch', 'generation', 'version', 'artifact', 'target'])
  requireValue(firmware.schema === 'mica/firmware/v1', 'unsupported schema')
  requireValue(typeof firmware.board === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(firmware.board)
    && (firmware.arch === 'amd64' || firmware.arch === 'arm64'), 'board/architecture mismatch')
  requireValue(Number.isSafeInteger(firmware.generation) && (firmware.generation as number) > 0, 'invalid generation')
  requireValue(typeof firmware.version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(firmware.version), 'invalid version')
  requireValue(typeof firmware.id === 'string' && /^[0-9a-f]{64}$/.test(firmware.id)
    && componentId(firmware) === firmware.id, 'identity mismatch')
  const artifact = object(firmware.artifact, ['bytes', 'sha256'])
  requireValue(typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256), 'invalid digest')
  requireValue(Number.isSafeInteger(artifact.bytes) && (artifact.bytes as number) > 0, 'invalid length')
  // The target's FORMAT says what the firmware is and how it is written; a board is data behind it
  // (board.env, layout.tsv), never a case here. An unknown format is read as the EFI one, and refused by its fields.
  const format = firmware.target !== null && typeof firmware.target === 'object' ? (firmware.target as { format?: unknown }).format : undefined
  const module = (FIRMWARE_FORMATS as Record<string, FirmwareFormatModule | undefined>)[String(format)] ?? FIRMWARE_FORMATS.efi
  const checked = module.checkTarget(object(firmware.target, [...module.targetFields]), String(firmware.arch), artifact.bytes as number)
  requireValue(!('refusal' in checked), 'refusal' in checked ? checked.refusal : '')
  if (facts !== undefined) {
    requireValue(firmware.board === facts.board && firmware.arch === facts.arch, `firmware is not board ${facts.board}'s`)
    requireValue(canonicalJson(firmware.target) === canonicalJson(firmwareTarget(facts)), `firmware target differs from what board ${facts.board} declares`)
  }
  return value as Firmware
}

export function authenticateFirmware(bytes: string, publicKeys: readonly string[], facts?: BoardFacts): Firmware {
  return parseFirmware(authenticatePayload(bytes, publicKeys), facts)
}
