#!/bin/sh

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/../../" && pwd)
dist=$script_dir/dist
program=$dist/usr/sbin/bm201-front-panel
stop_helper=$dist/usr/lib/mica/bm201-front-panel-stop
service=$dist/usr/lib/systemd/system/bm201-front-panel.service
drop_in=$dist/usr/lib/systemd/system/multi-user.target.d/bm201-front-panel.conf
board_env=$repo_root/board.env
test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/bm201-front-panel-systemd.XXXXXX")

cleanup()
{
	if [ -n "$test_tmp" ] && [ -d "$test_tmp" ]; then
		rm -rf "$test_tmp"
	fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

fail()
{
	printf 'FAIL: %s\n' "$1" >&2
	exit 1
}

assert_equal()
{
	expected=$1
	actual=$2
	message=$3
	if [ "$actual" != "$expected" ]; then
		fail "$message: expected '$expected', got '$actual'"
	fi
}

assert_content()
{
	expected=$1
	file=$2
	message=$3
	actual=$(cat "$file")
	assert_equal "$expected" "$actual" "$message"
}

assert_line()
{
	line=$1
	file=$2
	message=$3
	grep -Fx "$line" "$file" >/dev/null || fail "$message: missing '$line'"
}

for file in "$program" "$stop_helper"; do
	sh -n "$file"
done

assert_line '[Unit]' "$service" "unit section"
assert_line 'Description=BM201 front-panel clock and link status' "$service" \
	"unit description"
assert_line 'Wants=time-sync.target network-online.target' "$service" \
	"unit pulls time and network barriers"
assert_line 'After=time-sync.target network-online.target' "$service" \
	"unit orders after time and network barriers"
assert_line '[Service]' "$service" "service section"
assert_line 'Type=simple' "$service" "service type"
assert_line 'ExecStart=/usr/sbin/bm201-front-panel' "$service" "service command"
assert_line 'ExecStopPost=/usr/lib/mica/bm201-front-panel-stop' "$service" \
	"explicit stop command"
assert_line 'Restart=no' "$service" "optional panel does not restart-loop"
assert_line '[Install]' "$service" "install section"
assert_line 'WantedBy=multi-user.target' "$service" "install target"
if grep -q '^Environment=BM201_PANEL_ROOT=' "$service"; then
	fail "service hard-codes BM201_PANEL_ROOT instead of allowing an override"
fi

assert_content '[Unit]
Wants=bm201-front-panel.service' "$drop_in" "target drop-in"
assert_line 'BOARD_HWINIT_CONFS="wireless audio bluetooth"' "$board_env" \
	"front panel is not hwinit"
assert_line 'BOARD_USERLAND_FILES="/usr/lib/bluetooth/plugins/libskwbt.so /usr/sbin/skw_vhci_bridge /etc/bluetooth/skwbt.conf /etc/bluetooth/sv6160.nvbin /etc/bluetooth/sv6160lite.nvbin /etc/bluetooth/sv6316.nvbin"' \
	"$board_env" "front panel leaves BOARD_USERLAND_FILES Bluetooth-only"

panel=$test_tmp/panel
mkdir -p "$panel"
printf '1\n' > "$panel/enabled"
printf '1234\n' > "$panel/text"
printf '0xfd\n' > "$panel/symbols"
if ! BM201_PANEL_ROOT=$panel sh "$stop_helper" > "$test_tmp/stop-stdout" \
	2> "$test_tmp/stop-stderr"; then
	fail "writable-panel ExecStopPost helper failed"
fi
assert_content 0 "$panel/enabled" "explicit-stop disable"
assert_content 1234 "$panel/text" "explicit-stop digits"
assert_content 0xfd "$panel/symbols" "explicit-stop symbols"
if [ -s "$test_tmp/stop-stdout" ] || [ -s "$test_tmp/stop-stderr" ]; then
	fail "writable-panel ExecStopPost helper produced output"
fi

missing_panel=$test_tmp/missing-panel
if ! BM201_PANEL_ROOT=$missing_panel sh "$stop_helper" > "$test_tmp/missing-stop-stdout" \
	2> "$test_tmp/missing-stop-stderr"; then
	fail "missing-panel ExecStopPost helper failed"
fi
assert_content "bm201-front-panel: unable to disable BM201 front panel through $missing_panel/enabled" \
	"$test_tmp/missing-stop-stderr" "missing-panel stop warning"
if [ -e "$missing_panel" ]; then
	fail "missing-panel ExecStopPost helper created its panel root"
fi

unwritable_panel=$test_tmp/unwritable-panel
mkdir -p "$unwritable_panel/enabled"
if ! BM201_PANEL_ROOT=$unwritable_panel sh "$stop_helper" \
	> "$test_tmp/unwritable-stop-stdout" 2> "$test_tmp/unwritable-stop-stderr"; then
	fail "unwritable-panel ExecStopPost helper failed"
fi
assert_content "bm201-front-panel: unable to disable BM201 front panel through $unwritable_panel/enabled" \
	"$test_tmp/unwritable-stop-stderr" "unwritable-panel stop warning"

daemon_missing=$test_tmp/daemon-missing-panel
if BM201_PANEL_ROOT=$daemon_missing BM201_NET_ROOT=$test_tmp/network sh "$program" \
	> "$test_tmp/daemon-stdout" 2> "$test_tmp/daemon-stderr"; then
	daemon_status=0
else
	daemon_status=$?
fi
assert_equal 0 "$daemon_status" "missing-panel ExecStart exit status"
if [ -s "$test_tmp/daemon-stdout" ]; then
	fail "missing-panel ExecStart wrote to stdout"
fi
assert_content 'bm201-front-panel: panel controls unavailable' \
	"$test_tmp/daemon-stderr" "missing-panel ExecStart warning"
if [ -e "$daemon_missing" ]; then
	fail "missing-panel ExecStart created its panel root"
fi

printf 'bm201-front-panel systemd tests: PASS\n'
