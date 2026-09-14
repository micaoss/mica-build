// Stop acceptance callers at the native validation boundary before expensive packing.
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import * as kernelPackage from '../../build/src/kernel-package.ts'
import * as toolbox from '../../build/src/toolbox.ts'
import type { KernelInputs } from '../../build/src/kernel-package.ts'
import { loadBoardFacts } from '../../build/src/board-facts.ts'

const { kernelExecutables } = kernelPackage
mock.module('../../build/src/kernel-package.ts', () => ({
  ...kernelPackage,
  packKernel: async (input: KernelInputs) => {
    const executables = kernelExecutables(input.runkit, loadBoardFacts(input.board).arch)
    writeFileSync(process.env.MICA_FILE_AB_INPUT_CAPTURE!, JSON.stringify({ input, executables }))
    throw new Error('NATIVE_INPUT_CAPTURED')
  },
}))
mock.module('../../build/src/toolbox.ts', () => ({
  ...toolbox,
  Toolbox: { open: async () => ({ must: async () => '', close: async () => {} }) },
}))
