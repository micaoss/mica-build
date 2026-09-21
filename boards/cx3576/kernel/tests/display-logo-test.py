#!/usr/bin/env python3
"""Compile pinned logo generation, rendering, VT switch and Rockchip HPD code.

Usage: display-logo-test.py <kernel-source> <evidence-directory>
Run before and after the board patch. Kernel services are controlled by the C
fixture; the vendor functions under test are extracted without rewriting them.
This is a host regression, not a DRM device or physical-display qualification.
"""

from pathlib import Path
import re
import subprocess
import sys


def run(args: list[str]) -> None:
    subprocess.run(args, check=True, timeout=20)


def function(source: str, name: str) -> str:
    match = re.search(r"^(?:static )?(?:inline )?[\w *]+\b" + name +
                      r"\([^;]*?\)\n\{", source, re.MULTILINE)
    if match is None:
        raise ValueError(f"Missing vendor function: {name}")
    brace = source.index("{", match.start())
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end]


def main() -> int:
    root, evidence = map(Path, sys.argv[1:])
    evidence.mkdir(parents=True, exist_ok=True)
    headers = evidence / "linux"
    headers.mkdir(exist_ok=True)
    (headers / "linux_logo.h").write_bytes((root / "include/linux/linux_logo.h").read_bytes())
    (headers / "init.h").write_text(
        '#define __initdata __attribute__((section(".init.data")))\n'
        '#define __initconst __attribute__((section(".init.rodata")))\n'
        '#define __init\n#define __ref\n'
        '#define late_initcall_sync(fn) static void __attribute__((constructor)) '
        'logo_late_init(void) { fn(); }\n')
    (headers / "module.h").write_text(
        '#include <stdbool.h>\n#define module_param(...)\n'
        '#define MODULE_PARM_DESC(...)\n#define EXPORT_SYMBOL_GPL(...)\n')
    (headers / "stddef.h").write_text('#include <stddef.h>\n')
    logo_dir = root / "drivers/video/logo"
    run(["gcc", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror",
         str(logo_dir / "pnmtologo.c"), "-o", str(evidence / "pnmtologo")])
    kernel = Path(__file__).resolve().parents[1]
    run(["python3", str(Path(__file__).resolve().parents[4] / "common/kernel/mklogo.py"),
         str(kernel.parent / "flash/assets/splash.png"),
         str(evidence / "logo.ppm"), "720", "405"])
    run([str(evidence / "pnmtologo"), "-t", "clut224", "-n", "logo_linux_clut224",
         "-o", str(evidence / "logo.c"), str(evidence / "logo.ppm")])
    run(["gcc", "-I", str(evidence), "-fno-pie", "-c", str(evidence / "logo.c"),
         "-o", str(evidence / "logo.o")])
    symbols = subprocess.check_output(["objdump", "-t", str(evidence / "logo.o")],
                                      text=True, timeout=10)
    (evidence / "logo-symbols.txt").write_text(symbols)
    failures = 0
    for name in ("logo_linux_clut224", "logo_linux_clut224_data", "logo_linux_clut224_clut"):
        line, = (line for line in symbols.splitlines() if line.split()[-1:] == [name])
        retained = ".init" not in line and ".rodata" in line
        print(f"{'PASS' if retained else 'FAIL'} retained read-only artwork: {line}", flush=True)
        failures += not retained

    fbmem = (root / "drivers/video/fbdev/core/fbmem.c").read_text()
    fbcon = (root / "drivers/video/fbdev/core/fbcon.c").read_text()
    rockchip = (root / "drivers/gpu/drm/rockchip/rockchip_drm_fb.c").read_text()
    # The complete existing logo renderer, including palette and rotation code.
    renderer = fbmem[fbmem.index("static inline unsigned safe_shift("):
                     fbmem.index("\n#else\nint fb_prepare_logo(")]
    renderer = function(fbmem, "fb_get_color_depth") + "\n" + renderer
    redraw = ""
    if "static bool fbcon_show_idle_logo(" in fbcon:
        redraw += function(fbcon, "fbcon_show_idle_logo") + "\n"
    redraw += function(fbcon, "fbcon_switch") + "\n"
    redraw += function(fbcon, "fbcon_modechanged") + "\n"
    redraw += function(fbcon, "fbcon_set_all_vcs") + "\n"
    redraw += function(fbcon, "fbcon_update_vcs") + "\n"
    prepare = fbcon[fbcon.index("#else\nstatic void fbcon_prepare_logo("):]
    redraw += function(prepare, "fbcon_prepare_logo") + "\n"
    redraw += function(rockchip, "rockchip_drm_output_poll_changed")
    fixture = Path(__file__).with_name("display-logo-fixture.c").read_text()
    fixture = fixture.replace("/* VENDOR_RENDERER */", renderer)
    fixture = fixture.replace("/* VENDOR_REDRAW */", redraw)
    (evidence / "display-test.c").write_text(fixture)
    run(["gcc", "-std=gnu11", "-g", "-O1", "-Wall", "-Wextra", "-Werror",
         "-Wno-unused-parameter", "-Wno-unused-function", "-Wno-sign-compare",
         "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-no-pie",
         "-DCONFIG_LOGO_LINUX_CLUT224", "-I", str(evidence),
         str(evidence / "display-test.c"), str(logo_dir / "logo.c"),
         str(evidence / "logo.o"), "-o", str(evidence / "display-test")])
    result = subprocess.run([str(evidence / "display-test")], timeout=10, check=False)
    return int(bool(failures or result.returncode))


if __name__ == "__main__":
    raise SystemExit(main())
