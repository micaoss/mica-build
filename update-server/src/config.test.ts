import { expect, test } from 'bun:test'
import { parseConfig } from './config'

const token = 'test-token-that-is-longer-than-32-characters'
test('configuration validates credentials, origins and numeric limits', () => {
  expect(() => parseConfig({})).toThrow('ADMIN_TOKEN')
  expect(() => parseConfig({ ADMIN_TOKEN: token, PORT: '0' })).toThrow('PORT')
  for (const url of ['https://user:secret@example.test', 'file:///tmp', 'https://example.test/path', 'https://example.test?x=1'])
    expect(() => parseConfig({ ADMIN_TOKEN: token, PUBLIC_URL: url })).toThrow('PUBLIC_URL')
  const config = parseConfig({ ADMIN_TOKEN: token, SIGNING_KEY_FILE: '/test/key.pem' })
  expect(config.port).toBe(3000)
  expect(config.publicUrl).toBe('http://localhost:3000')
  expect(config.signingKeyFile).toBe('/test/key.pem')
  expect(parseConfig({ ADMIN_TOKEN: token, NSL_URL: 'http://mica-updates.localhost:1355' }).publicUrl).toBe('http://mica-updates.localhost:1355')
  expect(parseConfig({ ADMIN_TOKEN: token, NSL_URL: 'http://mica-updates.localhost:1355', PUBLIC_URL: 'https://updates.example.test' }).publicUrl).toBe('https://updates.example.test')
})
