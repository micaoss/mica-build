// The label of a device: its code, the SSID of its factory access point, that access point's key and the Wi-Fi QR
// payload, derived offline from the printed code and the product secret (src/product/device-code.ts). The key is
// the access point's only until the device is claimed (mica-core:docs/factory-ap-key.md).
//
//   bun src/cli.ts label --secret FILE <code>         the product secret, the file the build installed as
//                                                     /usr/share/mica/ap-secret
//   bun src/cli.ts label --development <product> <code>
//                                                     the development secret of a build given none
//
//   prints   code <XXXX-XXXX-XXX>, ssid <mica-XXXX>, psk <16 characters>, qr <WIFI:...;;>, one per line
import { readFileSync } from 'node:fs'
import { apPsk, developmentSecret, DeviceCodeError, parseCode, printed, qrPayload, secretBytes, ssid } from './device-code.ts'

const USAGE = 'usage: bun src/cli.ts label --secret FILE <code> | --development <product> <code>'

/** The label lines of a code under a product secret. */
export function label(secret: Uint8Array, input: string): string {
  const code = parseCode(input)
  const name = ssid(code), psk = apPsk(secret, code)
  return `code\t${printed(code)}\nssid\t${name}\npsk\t${psk}\nqr\t${qrPayload(name, psk)}\n`
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 3 || (argv[0] !== '--secret' && argv[0] !== '--development')) { console.error(USAGE); return 1 }
  try {
    let secret: Uint8Array
    if (argv[0] === '--secret') {
      let file: Buffer
      try { file = readFileSync(argv[1]!) }
      catch (e) { console.error(`error: ${argv[1]}: ${(e as Error).message}`); return 1 }
      secret = secretBytes(file, argv[1]!)
    }
    else { secret = developmentSecret(argv[1]!) }
    await Bun.write(Bun.stdout, label(secret, argv[2]!))
    return 0
  }
  catch (e) {
    if (e instanceof DeviceCodeError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
