#!/bin/sh
set -eu

# Pin upstream and apply the minimal macOS Clang compatibility patch.
upstream_url=https://github.com/rockchip-linux/rkdeveloptool.git
upstream_commit=304f073752fd25c854e1bcf05d8e7f925b1f4e14

case "$(uname -s)" in
	Darwin) ;;
	*) echo "error: this builder is for macOS" >&2; exit 1 ;;
esac

for tool in git autoreconf pkg-config make patch; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "error: missing $tool; run: brew install autoconf automake libusb pkg-config" >&2
		exit 1
	}
done

pkg-config --exists libusb-1.0 || {
	echo "error: missing libusb; run: brew install libusb" >&2
	exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
host_arch=$(uname -m)
# Where the board Makefile looks for a local build (TOOLS_DIR).
output_dir="$repo_root/flash/tools"
output_file="$output_dir/rkdeveloptool"
build_dir=$(mktemp -d /tmp/rkdeveloptool-macos.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM

git init -q "$build_dir/src"
git -C "$build_dir/src" remote add origin "$upstream_url"
git -C "$build_dir/src" fetch -q --depth=1 origin "$upstream_commit"
git -C "$build_dir/src" checkout -q --detach FETCH_HEAD
for patch_file in "$script_dir"/*.patch; do
	patch -s -d "$build_dir/src" -p1 < "$patch_file"
done

(
	cd "$build_dir/src"
	autoreconf -i
	CXXFLAGS='-O2' ./configure
	make -j"$(sysctl -n hw.logicalcpu)"
)

mkdir -p "$output_dir"
install -m 0755 "$build_dir/src/rkdeveloptool" "$output_file"
printf '%s\n' "$upstream_commit" > "$output_file.SOURCE_COMMIT"
(
	cd "$output_dir"
	shasum -a 256 rkdeveloptool > rkdeveloptool.sha256
)

"$output_file" -v
file "$output_file"
otool -L "$output_file"
cat "$output_dir/rkdeveloptool.sha256"
echo "output: $output_file ($host_arch)"
