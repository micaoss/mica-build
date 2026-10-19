#!/usr/bin/env python3
"""Exercise applied vendor boot functions with bounded host service adapters."""
import argparse
import ctypes as C
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


def function(source, name):
    text = source.read_text()
    match = re.search(r"^(?:static )?int " + name + r"\(", text, re.M)
    if not match:
        raise ValueError(f"missing vendor function: {name}")
    end = text.index("\n}\n", match.start()) + 3
    return text[match.start():end]


def host_headers(directory, source):
    headers = {
        "linux/types.h": "#pragma once\n#include <stdint.h>\n#include <stddef.h>\n#include <stdbool.h>\n#include <sys/types.h>\ntypedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64;\n",
        "linux/string.h": "#include <string.h>\n",
        "linux/compiler.h": "#pragma once\n#define noinline __attribute__((noinline))\n#ifndef __always_inline\n#define __always_inline inline __attribute__((always_inline))\n#endif\n#define likely(x) __builtin_expect(!!(x),1)\n#define unlikely(x) __builtin_expect(!!(x),0)\n#define __force\n",
        "linux/kernel.h": "#pragma once\n#include <stdint.h>\n#include <stddef.h>\n#include <limits.h>\n#include <stdlib.h>\n#include <linux/compiler.h>\n#define EXPORT_SYMBOL(x)\n#define ALIGN(x,a) (((x)+((__typeof__(x))(a)-1))&~((__typeof__(x))(a)-1))\n#define PTR_ALIGN(p,a) ((__typeof__(p))ALIGN((uintptr_t)(p),(a)))\n",
        "linux/compat.h": "#define EXPORT_SYMBOL(x)\n",
        "linux/errno.h": "#include <asm-generic/errno.h>\n",
        "compiler.h": "#include <stdint.h>\n#include <stddef.h>\n#include <stdbool.h>\n#include <endian.h>\n",
        "asm/unaligned.h": "#pragma once\n#include <stdint.h>\n#include <string.h>\n#include <endian.h>\n#define get_unaligned(p) ({ __typeof__(*(p)) v; memcpy((void *)&v,(p),sizeof(v)); v; })\n#define put_unaligned(v,p) do { __typeof__(*(p)) x=(v); memcpy((p),&x,sizeof(x)); } while(0)\n",
        "common.h": "#pragma once\n#include <assert.h>\n#include <errno.h>\n#include <limits.h>\n#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#define CONFIG_MICA_FILE_BOOT 1\n#define CONFIG_AMLOGIC_MODIFY 1\n#define debug(...) ((void)0)\n",
        "log.h": "#define log_err(...) fprintf(stderr,__VA_ARGS__)\n",
        "abuf.h": "#pragma once\n#include <stddef.h>\nstruct abuf { void *data; size_t size; };\nstatic inline size_t abuf_size(const struct abuf *b) { return b->size; }\nstatic inline void *abuf_data(const struct abuf *b) { return b->data; }\n",
    }
    for bits in (16, 32, 64):
        for order in ("le", "be"):
            headers["asm/unaligned.h"] += (
                f"static inline uint{bits}_t get_unaligned_{order}{bits}(const void *p) {{ uint{bits}_t v; memcpy(&v,p,sizeof(v)); return {order}{bits}toh(v); }}\n"
                f"static inline void put_unaligned_{order}{bits}(uint{bits}_t v, void *p) {{ v=hto{order}{bits}(v); memcpy(p,&v,sizeof(v)); }}\n"
            )
    for name, content in headers.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for name in ("zstd.h", "xxhash.h"):
        (directory / "linux" / name).symlink_to(source / "include/linux" / name)


def zstd_test(source, tests, work, cc, kernel, image):
    headers = work / "include"
    host_headers(headers, source)
    (work / "vendor-zstd-wrapper.c").write_bytes((source / "lib/zstd/zstd.c").read_bytes())
    files = [source / "lib/zstd" / f"{name}.c" for name in (
        "huf_decompress", "decompress", "entropy_common", "fse_decompress", "zstd_common"
    )]
    library = work / "zstd-test.so"
    subprocess.run([*cc, "-std=gnu11", "-O2", "-shared", "-fPIC", "-Werror", "-D__LITTLE_ENDIAN",
                    f"-I{headers}", f"-I{work}", *map(str, files), str(source / "lib/xxhash.c"),
                    str(tests / "fit-zstd.c"), "-o", str(library)], check=True)
    lib = C.CDLL(str(library))
    lib.probe_decode.argtypes = [C.c_void_p, C.c_size_t, C.c_void_p, C.c_size_t, C.c_size_t]
    lib.probe_decode.restype = C.c_int
    lib.probe_largest_allocation.restype = C.c_size_t
    modern = C.CDLL("libzstd.so.1")
    modern.ZSTD_createCCtx.restype = C.c_void_p
    modern.ZSTD_freeCCtx.argtypes = [C.c_void_p]
    modern.ZSTD_CCtx_setParameter.argtypes = [C.c_void_p, C.c_int, C.c_int]
    modern.ZSTD_CCtx_setParameter.restype = C.c_size_t
    modern.ZSTD_compress2.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.c_void_p, C.c_size_t]
    modern.ZSTD_compress2.restype = C.c_size_t
    modern.ZSTD_decompress.argtypes = [C.c_void_p, C.c_size_t, C.c_void_p, C.c_size_t]
    modern.ZSTD_decompress.restype = C.c_size_t
    expected = b"".join(hashlib.sha256(str(i).encode()).digest() * 64 for i in range(512))
    packed = C.create_string_buffer(len(expected) * 2)
    context = modern.ZSTD_createCCtx()
    assert context
    try:
        # Stable public ZSTD_c_compressionLevel and ZSTD_c_checksumFlag values.
        assert modern.ZSTD_CCtx_setParameter(context, 100, 19) == 19
        assert modern.ZSTD_CCtx_setParameter(context, 201, 1) == 1
        length = modern.ZSTD_compress2(context, packed, len(packed), expected, len(expected))
    finally:
        modern.ZSTD_freeCCtx(context)
    assert length < len(packed)
    compressed = packed.raw[:length]
    if kernel:
        compressed = kernel.read_bytes()
        expected = image.read_bytes()
    assert compressed[4] & 4, "test frame must carry a checksum"
    output_limit = 128 << 20
    output = C.create_string_buffer(output_limit)

    def decode(data, capacity=output_limit, budget=1 << 20):
        return lib.probe_decode(data, len(data), output, capacity, budget)

    result = decode(compressed)
    assert result == len(expected), f"decode returned {result}; expected {len(expected)}"
    assert output.raw[:result] == expected
    assert lib.probe_largest_allocation() <= 1 << 20
    assert modern.ZSTD_decompress(output, output_limit, compressed, len(compressed)) == len(expected)
    assert output.raw[:len(expected)] == expected
    assert decode(compressed, budget=0) == -12, "allocation failure must remain negative"
    assert decode(compressed, capacity=1024) < 0, "output bound must be enforced"
    assert decode(compressed, capacity=0) < 0, "empty output must fail"
    assert decode(compressed, capacity=1 << 31) < 0, "return-size overflow must fail"
    assert decode(b"") < 0, "empty input must fail"
    assert decode(compressed[:-1]) < 0, "truncated frame must fail"
    assert decode(compressed + b"garbage") < 0, "trailing garbage must fail"
    assert decode(b"invalid") < 0, "invalid frame must fail"
    assert decode(compressed[:-1] + bytes([compressed[-1] ^ 1])) < 0
    print(f"MICA_ZSTD_BOUNDS_PASS: expanded={len(expected)}; workspace<=1048576", flush=True)


def fdt_test(source, tests, work, cc):
    text = "\n".join((function(source / "boot/image-fdt.c", "select_fdt"),
                      function(source / "boot/image-fdt.c", "boot_get_fdt"),
                      function(source / "boot/bootm.c", "bootm_find_images")))
    (work / "vendor-fdt-functions.c").write_text(text)
    for flags, name in (([], "mica"), (["-DTEST_VENDOR_PATH"], "vendor")):
        binary = work / f"fdt-{name}"
        subprocess.run([*cc, "-std=gnu11", "-O1", "-Wall", "-Werror", "-Wno-unused-function",
                        "-Wno-unused-but-set-variable", "-Wno-unused-variable", *flags,
                        f"-I{work}", str(tests / "fit-fdt.c"), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="applied vendor tree (bl33/v2023)")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--kernel", type=Path)
    parser.add_argument("--image", type=Path)
    args = parser.parse_args()
    if bool(args.kernel) != bool(args.image):
        parser.error("--kernel and --image must be supplied together")
    cc = shlex.split(os.environ.get("HOSTCC", "cc"))
    tests = Path(__file__).resolve().parent
    failures = []
    with tempfile.TemporaryDirectory(prefix="mica-fit-test-") as temporary:
        work = Path(temporary)
        cases = {
            "zstd": lambda: zstd_test(args.source.resolve(), tests, work, cc, args.kernel, args.image),
            "fdt": lambda: fdt_test(args.source.resolve(), tests, work, cc),
        }
        for name, run in cases.items():
            try:
                run()
            except (AssertionError, subprocess.CalledProcessError) as error:
                failures.append(name)
                print(f"FAIL {name}: {error}", flush=True)
        if args.config:
            config = args.config.read_text().splitlines()
            if "CONFIG_AMLOGIC_AMFC=y" in config or "CONFIG_ZSTD=y" not in config:
                failures.append("config")
                print("FAIL config: Mica requires software Zstd with AMFC disabled", flush=True)
    if failures:
        raise SystemExit("SIGNED_FIT_REGRESSION_FAIL: " + ", ".join(failures))
    print("SIGNED_FIT_REGRESSION_PASS", flush=True)


if __name__ == "__main__":
    main()
