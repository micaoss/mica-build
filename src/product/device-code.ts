// The device code and the factory access-point key (mica-core:docs/factory-ap-key.md): what micad derives on the
// device, derived here offline for the label. A board's code source is one fixed name, which product.env declares
// (DEVICE_CODE_SOURCE) and the composer writes into /usr/share/mica/device-code.conf.
//
//   code  d = SHA-256("mica-device-code-v1" 0x00 source 0x00 raw); the first 50 bits of d as 10 characters of
//         ALPHABET, then one Luhn mod-32 check character. Printed XXXX-XXXX-XXX; canonical without the dashes.
//   SSID  mica-<data characters 7 to 10>
//   PSK   k = HMAC-SHA256(secret, "mica-ap-psk-v1" 0x00 canonical code); the first 16 bytes of k, each % 32, as
//         characters of ALPHABET
import { createHash, createHmac } from 'node:crypto'

export class DeviceCodeError extends Error {}

/** The readable 32-character alphabet: no 0 O 1 I, no lowercase. */
export const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** The sources micad reads a code from. */
export const SOURCES = ['emmc-cid', 'dt-serial', 'dmi-serial', 'dmi-uuid', 'mac'] as const

/** The shortest product secret micad accepts, in bytes, after one trailing newline is stripped. */
export const SECRET_MIN_BYTES = 32

const N = ALPHABET.length

/** The Luhn mod-32 check character over data characters. */
function check(data: string): string {
  let factor = 2, sum = 0
  for (let i = data.length - 1; i >= 0; i--) {
    let addend = factor * ALPHABET.indexOf(data[i]!)
    factor = factor === 2 ? 1 : 2
    addend = Math.floor(addend / N) + (addend % N)
    sum += addend
  }
  return ALPHABET[(N - (sum % N)) % N]!
}

/** The canonical code of a raw value read from a source: 10 data characters and the check character. */
export function deviceCode(source: string, raw: Uint8Array | string): string {
  if (!(SOURCES as readonly string[]).includes(source)) throw new DeviceCodeError(`error: '${source}' is no device code source; the sources are: ${SOURCES.join(' ')}`)
  // The bytes read, the ASCII whitespace around them removed.
  const value = Buffer.from(Buffer.from(raw).toString('latin1').replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ''), 'latin1')
  const d = createHash('sha256').update('mica-device-code-v1\0').update(source).update('\0').update(value).digest()
  let bits = 0n
  for (const byte of d.subarray(0, 7)) bits = (bits << 8n) | BigInt(byte)
  bits >>= 6n
  let data = ''
  for (let i = 9; i >= 0; i--) data += ALPHABET[Number((bits >> BigInt(5 * i)) & 31n)]
  return data + check(data)
}

/** The canonical code of a printed or canonical input; refused unless it is 11 characters of ALPHABET whose check holds. */
export function parseCode(input: string): string {
  const code = input.trim().toUpperCase().replaceAll('-', '')
  if (!/^[23456789A-HJ-NP-Z]{11}$/.test(code)) throw new DeviceCodeError(`error: '${input}' is no device code: 11 characters of ${ALPHABET}, printed XXXX-XXXX-XXX`)
  if (check(code.slice(0, 10)) !== code[10]) throw new DeviceCodeError(`error: '${input}' fails its check character; a character is wrong or two are swapped`)
  return code
}

/** The printed form XXXX-XXXX-XXX. */
export function printed(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`
}

/** The SSID: mica- and data characters 7 to 10. */
export function ssid(code: string): string {
  return `mica-${code.slice(6, 10)}`
}

/** The product secret micad keys on: the file's bytes, one trailing newline stripped; refused when short. */
export function secretBytes(file: Uint8Array, name: string): Buffer {
  let bytes = Buffer.from(file)
  if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, -1)
  if (bytes.length < SECRET_MIN_BYTES) throw new DeviceCodeError(`error: ${name} holds ${bytes.length} byte(s); a product secret is at least ${SECRET_MIN_BYTES}`)
  return bytes
}

/** The factory access-point key of a code under a product secret. */
export function apPsk(secret: Uint8Array, code: string): string {
  const k = createHmac('sha256', secret).update('mica-ap-psk-v1\0').update(code).digest()
  return [...k.subarray(0, 16)].map(b => ALPHABET[b % N]).join('')
}

/** The Wi-Fi QR payload a phone joins from. Neither the SSID nor the key carries a character the format escapes. */
export function qrPayload(name: string, psk: string): string {
  return `WIFI:T:WPA;S:${name};P:${psk};;`
}

/** The development secret of a product: public, derived from its name, for a build given no secret. publish refuses
 * a wifi product carrying it (src/release/scoped.ts). */
export function developmentSecret(product: string): Buffer {
  return createHash('sha256').update('mica-development-ap-secret-v1\0').update(product).digest()
}
