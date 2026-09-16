// The proof that the parser refuses what it says it refuses.
//
// Every negative case here asserts TWO things: that the input is rejected, and
// that the message NAMES the construct. An exit code alone is satisfied by a
// parser that rejects everything, which is why each refusal sits next to a
// POSITIVE CONTROL -- the nearly-identical input that is legitimate, and must
// still be accepted. `src/lint.test.ts` keeps the same discipline, and
// so does this file, one layer underneath both.

import { describe, expect, test } from 'bun:test'
import { BoardEnvError, evaluateArithmetic, parseBoardEnv } from './board-env.ts'

const PATH = 'fixture/board.env'

function parse(text: string) {
  return parseBoardEnv(text, PATH)
}

function valueOf(text: string, key: string): string | undefined {
  return parse(text).values.get(key)
}

/** Assert the input is refused AND that the message names the fault. */
function refuses(text: string, names: string): BoardEnvError {
  let err: unknown
  try {
    parse(text)
  } catch (e) {
    err = e
  }
  if (err === undefined) {
    throw new Error(`the parser ACCEPTED an input it must refuse (expected a message naming ${JSON.stringify(names)}):\n${text}`)
  }
  if (!(err instanceof BoardEnvError)) throw err
  if (!err.message.includes(names)) {
    throw new Error(`refused, but no message named ${JSON.stringify(names)}. Said: ${err.message}`)
  }
  return err
}

describe('the shapes a real board.env contains', () => {
  test('a bare assignment', () => {
    expect(valueOf('LAYOUT_BOARD=uefi-x64\n', 'LAYOUT_BOARD')).toBe('uefi-x64')
  })

  test('comments, blank lines and indentation', () => {
    const f = parse('# a header\n\n   \nSECTOR_SIZE=512\n\t# indented comment\n  MIB_BYTES=1048576\n')
    expect(f.values.get('SECTOR_SIZE')).toBe('512')
    expect(f.values.get('MIB_BYTES')).toBe('1048576')
    expect(f.assignments.length).toBe(2)
  })

  test('a trailing comment ends the line, and a bare # inside a value does not', () => {
    expect(valueOf('A=512   # the sector size\n', 'A')).toBe('512')
    expect(valueOf('A=ttyS0#1\n', 'A')).toBe('ttyS0#1')
  })

  test('a double-quoted value keeps its spaces and its = signs', () => {
    const v = valueOf('BOARD_CMDLINE_ARGS="console=tty0 console=ttyS0,115200 net.ifnames=0"\n', 'BOARD_CMDLINE_ARGS')
    expect(v).toBe('console=tty0 console=ttyS0,115200 net.ifnames=0')
  })

  test('a single-quoted value expands nothing', () => {
    expect(valueOf('A=\'$NOT ${EITHER} $(nor this)\'\n', 'A')).toBe('$NOT ${EITHER} $(nor this)')
  })

  test('${NAME} resolves against a key declared above it', () => {
    expect(valueOf('MICA_VAR_MIB=512\nEPHEMERAL_SIZE_MIB="${MICA_VAR_MIB}"\n', 'EPHEMERAL_SIZE_MIB')).toBe('512')
    expect(valueOf('A=1\nB=$A\n', 'B')).toBe('1')
  })

  test('interpolation mixes with literal text, and @SLOT@ is literal', () => {
    const text = 'BOOT_SCRIPT_NAME=boot.scr\nBOOT_SLOT_REQUIRED_FILES="Image rk3576-src.dtb ${BOOT_SCRIPT_NAME} mica-verity-@SLOT@.env"\n'
    expect(valueOf(text, 'BOOT_SLOT_REQUIRED_FILES')).toBe('Image rk3576-src.dtb boot.scr mica-verity-@SLOT@.env')
  })

  test('$(( )) does integer arithmetic over earlier keys', () => {
    const text = 'SECTOR_SIZE=512\nMIB_BYTES=1048576\nESP_START_MIB=1\nESP_START_SECTOR=$((ESP_START_MIB * MIB_BYTES / SECTOR_SIZE))\nESP_OFFSET_BYTES=$((ESP_START_MIB * MIB_BYTES))\n'
    const f = parse(text)
    expect(f.values.get('ESP_START_SECTOR')).toBe('2048')
    expect(f.values.get('ESP_OFFSET_BYTES')).toBe('1048576')
  })

  test('$(( )) honours precedence, parentheses, unary minus and $NAME spellings', () => {
    expect(valueOf('A=2\nB=3\nC=4\nX=$((A + B * C))\n', 'X')).toBe('14')
    expect(valueOf('A=2\nB=3\nC=4\nX=$(((A + B) * C))\n', 'X')).toBe('20')
    expect(valueOf('A=7\nX=$((-A + 1))\n', 'X')).toBe('-6')
    expect(valueOf('A=7\nB=2\nX=$(($A / ${B}))\n', 'X')).toBe('3')
    expect(valueOf('A=7\nB=2\nX=$((A % B))\n', 'X')).toBe('1')
  })

  test('a declared-empty value is present and empty, which is not absent', () => {
    const f = parse('BOARD_FIRMWARE_FILES=""\nBOARD_RADIOS=\n')
    expect(f.values.get('BOARD_FIRMWARE_FILES')).toBe('')
    expect(f.values.get('BOARD_RADIOS')).toBe('')
    expect(f.values.has('BOARD_HWINIT_CONFS')).toBe(false)
    expect(f.values.get('BOARD_HWINIT_CONFS')).toBeUndefined()
  })

  test('double quotes honour exactly the four shell escapes', () => {
    expect(valueOf('A="\\$HOME"\n', 'A')).toBe('$HOME')
    expect(valueOf('A="say \\"hi\\""\n', 'A')).toBe('say "hi"')
    expect(valueOf('A="back\\\\slash"\n', 'A')).toBe('back\\slash')
    expect(valueOf('A="\\`not a command\\`"\n', 'A')).toBe('`not a command`')
    // Before anything else the backslash is itself literal, as in a shell,
    // which is what keeps a Windows-style path reading as it is written.
    expect(valueOf('A="C:\\dir"\n', 'A')).toBe('C:\\dir')
  })

  test('a quoted value may span lines, and the next assignment still reports its own line', () => {
    const f = parse('A="one\ntwo"\nB=3\n')
    expect(f.values.get('A')).toBe('one\ntwo')
    expect(f.assignments[1]!.line).toBe(3)
  })

  test('adjacent segments concatenate, as a shell concatenates words', () => {
    expect(valueOf('A=1\nB=pre"mid"\'post\'${A}\n', 'B')).toBe('premidpost1')
  })
})

describe('what it refuses, and what it must still accept', () => {
  test('command substitution, in both spellings', () => {
    refuses('A=$(date)\n', 'command substitution')
    refuses('A=`date`\n', 'backtick command substitution')
    refuses('A="prefix $(date)"\n', 'command substitution')
    refuses('A="prefix `date`"\n', 'backtick command substitution')
    // control: the same characters, quoted so a shell would not run them either
    expect(valueOf('A=\'$(date)\'\n', 'A')).toBe('$(date)')
  })

  test('every parameter expansion operator, including the :- that hides an absent key', () => {
    refuses('U=1\nA=${U:-fallback}\n', 'parameter expansion operator')
    refuses('U=1\nA=${U#pre}\n', 'parameter expansion operator')
    refuses('U=1\nA=${U/a/b}\n', 'parameter expansion operator')
    refuses('U=1\nA=${#U}\n', 'length expansion')
    refuses('U=1\nA=${!U}\n', 'indirect expansion')
    refuses('A=${}\n', 'cannot start a name')
    // control: the plain form it exists to allow
    expect(valueOf('U=1\nA=${U}\n', 'A')).toBe('1')
  })

  test('a reference to a key this file does not define', () => {
    refuses('A=${NOT_DECLARED}\n', 'has not defined it above')
    // Order matters, exactly as it does to a shell reading top to bottom.
    refuses('A=${B}\nB=1\n', 'has not defined it above')
    expect(valueOf('B=1\nA=${B}\n', 'A')).toBe('1')
  })

  test('the process environment is never consulted', () => {
    process.env['MICA_BOARD_ENV_LEAK_PROBE'] = 'leaked'
    try {
      const err = refuses('A=${MICA_BOARD_ENV_LEAK_PROBE}\n', 'has not defined it above')
      expect(err.message).toContain('the process environment is not consulted')
    } finally {
      delete process.env['MICA_BOARD_ENV_LEAK_PROBE']
    }
  })

  test('shell special parameters and a bare $', () => {
    refuses('A=$@\n', 'shell special parameter')
    refuses('A=$1\n', 'shell special parameter')
    refuses('A=$\n', 'a bare `$`')
    expect(valueOf('A="\\$"\n', 'A')).toBe('$')
  })

  test('a command prefix is not an assignment', () => {
    refuses('export A=1\n', 'is a command, not an assignment')
    refuses('unset A\n', 'is a command, not an assignment')
    refuses('echo hi\n', 'not `=`')
    refuses('1BAD=x\n', 'expected NAME=value')
    expect(valueOf('A=1\n', 'A')).toBe('1')
  })

  test('unquoted whitespace, metacharacters and globs', () => {
    refuses('A=one two\n', 'Unquoted whitespace ends a value')
    refuses('A=one;rm -rf /\n', 'shell metacharacter')
    refuses('A=one|two\n', 'shell metacharacter')
    refuses('A=one&two\n', 'shell metacharacter')
    refuses('A=*.img\n', 'glob character')
    // A shell expands this one, so taking it literally would be a silent
    // disagreement with every existing consumer rather than a safe default.
    refuses('A=~/boards\n', 'A shell expands `~` on the right of an assignment')
    refuses('A=$\'a\\nb\'\n', 'ANSI-C quoting')
    expect(valueOf('A="one two"\n', 'A')).toBe('one two')
    expect(valueOf('A=^orphan_file,^metadata_csum_seed\n', 'A')).toBe('^orphan_file,^metadata_csum_seed')
    expect(valueOf('A=@1577836800\n', 'A')).toBe('@1577836800')
    expect(valueOf('A=/usr/lib/firmware/fw.bin\n', 'A')).toBe('/usr/lib/firmware/fw.bin')
    expect(valueOf('A="~/literal"\n', 'A')).toBe('~/literal')
  })

  test('an unterminated quote is reported where it OPENED, not at the end of the file', () => {
    const dq = refuses('A=1\nB="never closed\nC=3\n', 'unterminated double quote')
    expect(dq.line).toBe(2)
    const sq = refuses('A=1\nB=\'never closed\nC=3\n', 'unterminated single quote')
    expect(sq.line).toBe(2)
  })

  test('a line continuation', () => {
    refuses('A=one\\\ntwo\n', 'line continuation')
    refuses('A="one\\\ntwo"\n', 'line continuation')
  })

  test('DOS line endings', () => {
    const err = refuses('A=1\r\nB=2\r\n', 'carriage return')
    expect(err.line).toBe(1)
  })

  test('arithmetic that is not integer arithmetic', () => {
    refuses('A=$((MISSING + 1))\n', 'has not defined it above')
    refuses('A=abc\nB=$((A + 1))\n', 'not an integer')
    refuses('A=$((1 / 0))\n', 'division by zero')
    refuses('A=$((1 % 0))\n', 'division by zero')
    refuses('A=$((1 & 2))\n', 'not one of the operators')
    refuses('A=$((1 << 2))\n', 'not one of the operators')
    refuses('A=$((2 ** 3))\n', 'exponentiation')
    refuses('A=1\nB=$((A = 2))\n', 'does not compare or assign')
    refuses('A=$((0x10))\n', 'hexadecimal literal')
    refuses('A=$((010))\n', 'leading zero')
    refuses('A=$((1 + 2\n', 'unterminated `$((`')
    refuses('A=$(($(date)))\n', 'command substitution')
    // control: the arithmetic the boards actually use
    expect(valueOf('A=1\nB=1048576\nC=512\nX=$((A * B / C))\n', 'X')).toBe('2048')
  })

  test('byte offsets are exact past 2^53, where a double stops being', () => {
    // A number would round 9007199254740993 to ...992. These are byte offsets;
    // a size that is silently one byte out is the whole class of defect this
    // package exists to make visible.
    expect(valueOf('A=9007199254740992\nX=$((A + 1))\n', 'X')).toBe('9007199254740993')
  })
})

describe('bookkeeping', () => {
  test('a duplicated key takes the last value, and the duplication is reported', () => {
    const f = parse('A=1\nB=2\nA=3\n')
    expect(f.values.get('A')).toBe('3')
    expect(f.assignments.length).toBe(3)
    expect(f.duplicates.length).toBe(1)
    expect(f.duplicates[0]!.key).toBe('A')
    expect(f.duplicates[0]!.winner).toBe(3)
    expect(f.duplicates[0]!.overridden).toEqual([1])
  })

  test('a clean file reports no duplicates', () => {
    expect(parse('A=1\nB=2\n').duplicates).toEqual([])
  })

  test('an error carries the path, the line, the column and the line itself', () => {
    const err = refuses('A=1\nB=2\nC=$(hostname)\n', 'command substitution')
    expect(err.path).toBe(PATH)
    expect(err.line).toBe(3)
    expect(err.column).toBe(3)
    expect(err.sourceLine).toBe('C=$(hostname)')
    expect(err.message).toContain(`${PATH}:3:3:`)
  })

  test('raw keeps the value as written, value keeps what it means', () => {
    const f = parse('A=2\nB=$((A * 3))\n')
    expect(f.assignments[1]!.raw).toBe('$((A * 3))')
    expect(f.assignments[1]!.value).toBe('6')
  })
})

describe('the arithmetic evaluator on its own', () => {
  const lookup = (n: string): bigint => {
    const table: Record<string, bigint> = { A: 10n, B: 3n }
    const v = table[n]
    if (v === undefined) throw new Error(`no ${n}`)
    return v
  }
  const reject = (r: string): Error => new Error(r)

  test('truncates toward zero, as a shell does', () => {
    expect(evaluateArithmetic('7 / 2', lookup, reject)).toBe(3n)
    expect(evaluateArithmetic('-7 / 2', lookup, reject)).toBe(-3n)
    expect(evaluateArithmetic('-7 % 2', lookup, reject)).toBe(-1n)
  })

  test('left-associates operators of equal precedence', () => {
    expect(evaluateArithmetic('A * B / B', lookup, reject)).toBe(10n)
    expect(evaluateArithmetic('100 / 10 / 2', lookup, reject)).toBe(5n)
    expect(evaluateArithmetic('10 - 3 - 2', lookup, reject)).toBe(5n)
  })
})
