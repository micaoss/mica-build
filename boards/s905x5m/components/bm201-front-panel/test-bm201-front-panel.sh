#!/bin/sh

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
program=$script_dir/dist/usr/sbin/bm201-front-panel
test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/bm201-front-panel.XXXXXX")
mock_bin=$test_tmp/bin
capture_pids=
guard_pids=
capture_fail_attribute=
capture_stop_file=
updater_pid=
watchdog_pid=
watchdog_ready_file=
lifecycle_timeout=5
fifo_guard_lifetime=60

stop_watchdog()
{
	if [ -n "$watchdog_pid" ]; then
		if [ -n "$watchdog_ready_file" ] && \
			[ -e "$watchdog_ready_file" ]; then
			kill -s TERM "$watchdog_pid" 2>/dev/null || :
		fi
		wait "$watchdog_pid" 2>/dev/null || :
		watchdog_pid=
	fi
}

stop_updater()
{
	if [ -n "$updater_pid" ]; then
		kill -s KILL "$updater_pid" 2>/dev/null || :
		wait "$updater_pid" 2>/dev/null || :
		updater_pid=
	fi
}

stop_captures()
{
	if [ -n "$capture_stop_file" ]; then
		: > "$capture_stop_file" 2>/dev/null || :
	fi
	for guard_pid in $guard_pids; do
		kill -s KILL "$guard_pid" 2>/dev/null || :
	done
	for capture_pid in $capture_pids; do
		kill -s KILL "$capture_pid" 2>/dev/null || :
	done
	for guard_pid in $guard_pids; do
		wait "$guard_pid" 2>/dev/null || :
	done
	for capture_pid in $capture_pids; do
		wait "$capture_pid" 2>/dev/null || :
	done
	guard_pids=
	capture_pids=
}

cleanup()
{
	trap - 0 HUP INT TERM
	stop_watchdog
	stop_updater
	stop_captures
	if [ -n "$test_tmp" ] && [ -d "$test_tmp" ]; then
		rm -rf "$test_tmp"
	fi
	test_tmp=
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

assert_line_count()
{
	expected=$1
	file=$2
	message=$3
	actual=$(wc -l < "$file")
	if [ "$actual" -ne "$expected" ]; then
		fail "$message: expected $expected writes, got $actual"
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

mkdir -p "$mock_bin"
cat > "$mock_bin/date" <<'EOF_DATE'
#!/bin/sh

if [ "$#" -ne 1 ] || [ "$1" != "+%H%M %S" ]; then
	exit 1
fi

if [ -n "${BM201_TEST_TZ_LOG:-}" ]; then
    printf '%s\n' "${TZ:-unset}" >> "$BM201_TEST_TZ_LOG"
fi
: "${BM201_TEST_DATE_FILE:?}"
: "${BM201_TEST_DATE_INDEX:?}"

if [ -n "${BM201_TEST_DATE_LOG:-}" ]; then
	printf '%s\n' "$1" >> "$BM201_TEST_DATE_LOG"
fi

date_index=1
if [ -r "$BM201_TEST_DATE_INDEX" ]; then
	IFS= read -r date_index < "$BM201_TEST_DATE_INDEX" || exit 1
fi
case $date_index in
	"" | *[!0-9]*)
		exit 1
		;;
esac

date_value=$(sed -n "${date_index}p" "$BM201_TEST_DATE_FILE")
[ -n "$date_value" ] || exit 1
printf '%s\n' "$date_value"
printf '%s\n' "$((date_index + 1))" > "$BM201_TEST_DATE_INDEX"
EOF_DATE

cat > "$mock_bin/sleep" <<'EOF_SLEEP'
#!/bin/sh

[ "$#" -eq 1 ] || exit 1
: "${BM201_TEST_SLEEP_LOG:?}"
printf '%s\n' "$1" >> "$BM201_TEST_SLEEP_LOG"
EOF_SLEEP
chmod +x "$mock_bin/date" "$mock_bin/sleep"

record_capture_failure()
{
	failure_attribute=$1
	failure_reason=$2
	if mkdir "$capture_failure_dir/first.lock" 2>/dev/null; then
		printf 'capture %s: %s\n' "$failure_attribute" "$failure_reason" \
			> "$capture_failure_dir/first" || :
	fi
	printf 'capture %s: %s\n' "$failure_attribute" "$failure_reason" \
		> "$capture_failure_dir/$failure_attribute" || :

	failed_updater_pid=
	if [ -s "$updater_pid_file" ]; then
		IFS= read -r failed_updater_pid < "$updater_pid_file" || \
			failed_updater_pid=
	fi
	case $failed_updater_pid in
		"" | 0 | *[!0-9]*)
			;;
		*)
			kill -s KILL "$failed_updater_pid" 2>/dev/null || :
			;;
	esac
}

capture_fifo_stream()
{
	while :; do
		capture_value=
		if IFS= read -r capture_value; then
			capture_read_status=0
		else
			capture_read_status=$?
			if [ -e "$capture_stop_file" ]; then
				return 0
			fi
			record_capture_failure "$capture_attribute" \
				"read failed or reached EOF (status $capture_read_status)"
			return 1
		fi
		if ! printf '%s\n' "$capture_value" >> "$capture_log_path"; then
			record_capture_failure "$capture_attribute" \
				"capture log write failed"
			return 1
		fi
	done
}

capture_fifo()
{
	capture_attribute=$1
	capture_fifo_path=$2
	capture_log_path=$3

	if [ "$capture_attribute" = "$capture_fail_attribute" ]; then
		while [ ! -s "$updater_pid_file" ]; do
			:
		done
		record_capture_failure "$capture_attribute" \
			"forced reader failure"
		return 1
	fi

	capture_fifo_stream < "$capture_fifo_path"
}

start_captures()
{
	for capture_attribute in text symbols brightness enabled; do
		mkfifo "$panel_root/$capture_attribute"
		: > "$writes_root/$capture_attribute"
		(
			trap - 0 HUP INT TERM
			capture_fifo "$capture_attribute" \
				"$panel_root/$capture_attribute" \
				"$writes_root/$capture_attribute"
		) &
		capture_pids="$capture_pids $!"
		sleep "$fifo_guard_lifetime" > "$panel_root/$capture_attribute" &
		guard_pids="$guard_pids $!"
	done
}

watch_processes()
{
	trap - 0
	watched_timeout_file=$1
	watched_ready_file=$2
	watched_timeout_reason=$3
	shift
	shift
	shift
	watchdog_sleep_pid=

	stop_watchdog_sleep()
	{
		trap - HUP INT TERM
		if [ -n "$watchdog_sleep_pid" ]; then
			kill -s KILL "$watchdog_sleep_pid" 2>/dev/null || :
			wait "$watchdog_sleep_pid" 2>/dev/null || :
			watchdog_sleep_pid=
		fi
		exit 0
	}
	trap stop_watchdog_sleep HUP INT TERM

	sleep "$lifecycle_timeout" &
	watchdog_sleep_pid=$!
	if ! : > "$watched_ready_file"; then
		stop_watchdog_sleep
	fi
	if wait "$watchdog_sleep_pid"; then
		watchdog_sleep_status=0
	else
		watchdog_sleep_status=$?
	fi
	watchdog_sleep_pid=
	trap - HUP INT TERM

	if [ "$watchdog_sleep_status" -eq 0 ]; then
		printf '%s\n' "$watched_timeout_reason" > "$watched_timeout_file"
	else
		printf 'FIFO lifecycle watchdog failed with status %s\n' \
			"$watchdog_sleep_status" > "$watched_timeout_file"
	fi
	for watched_pid in "$@"; do
		kill -s KILL "$watched_pid" 2>/dev/null || :
	done
}

wait_for_watchdog()
{
	watchdog_ready_attempts=0
	while [ ! -e "$watchdog_ready_file" ]; do
		if ! kill -0 "$watchdog_pid" 2>/dev/null; then
			return 1
		fi
		watchdog_ready_attempts=$((watchdog_ready_attempts + 1))
		if [ "$watchdog_ready_attempts" -ge 100 ]; then
			return 1
		fi
		sleep 0 || :
	done
}

finish_captures()
{
	capture_finish_failure=
	if ! : > "$capture_stop_file"; then
		capture_finish_failure="could not publish capture stop state"
		stop_captures
		return 0
	fi

	for guard_pid in $guard_pids; do
		kill -s KILL "$guard_pid" 2>/dev/null || :
	done
	for guard_pid in $guard_pids; do
		wait "$guard_pid" 2>/dev/null || :
	done
	guard_pids=

	rm -f "$capture_drain_timeout_file" "$capture_drain_ready_file"
	watchdog_ready_file=$capture_drain_ready_file
	watch_processes "$capture_drain_timeout_file" \
		"$capture_drain_ready_file" \
		"capture drain exceeded $lifecycle_timeout-second lifecycle bound" \
		$capture_pids &
	watchdog_pid=$!
	if ! wait_for_watchdog; then
		stop_watchdog
		stop_captures
		capture_finish_failure="capture drain watchdog failed to initialize"
		return 0
	fi

	for capture_pid in $capture_pids; do
		wait "$capture_pid" 2>/dev/null || :
	done
	capture_pids=
	stop_watchdog
	if [ -s "$capture_drain_timeout_file" ]; then
		IFS= read -r capture_finish_failure \
			< "$capture_drain_timeout_file" || \
			capture_finish_failure="unreadable capture drain timeout report"
	fi
}

case_number=0
new_case()
{
	case_number=$((case_number + 1))
	case_root=$test_tmp/case-$case_number
	panel_root=$case_root/panel
	net_root=$case_root/net
	writes_root=$case_root/writes
	date_file=$case_root/dates
	date_index=$case_root/date-index
	date_log=$case_root/date-log
	sleep_log=$case_root/sleep-log
	stdout_log=$case_root/stdout
	stderr_log=$case_root/stderr
	capture_failure_dir=$case_root/capture-failures
	capture_stop_file=$case_root/captures-stopping
	updater_pid_file=$case_root/updater-pid
	updater_timeout_file=$case_root/updater-timeout
	updater_watchdog_ready_file=$case_root/updater-watchdog-ready
	capture_drain_timeout_file=$case_root/capture-drain-timeout
	capture_drain_ready_file=$case_root/capture-drain-ready

	mkdir -p "$panel_root" "$net_root/eth0" "$net_root/p2p0" \
		"$writes_root" "$capture_failure_dir"
	printf '%s\n' "$1" > "$net_root/eth0/carrier"
	printf '%s\n' "$2" > "$net_root/p2p0/carrier"
	: > "$date_file"
	printf '1\n' > "$date_index"
	: > "$date_log"
	: > "$sleep_log"
	start_captures
}

set_dates()
{
	: > "$date_file"
	for date_value in "$@"; do
		printf '%s\n' "$date_value" >> "$date_file"
	done
	printf '1\n' > "$date_index"
}

run_case_lifecycle()
{
	test_iterations=$1
	shift
	rm -f "$updater_pid_file" "$updater_timeout_file" \
		"$updater_watchdog_ready_file"
	BM201_PANEL_ROOT=$panel_root \
		BM201_NET_ROOT=$net_root \
		BM201_TEST_DATE_FILE=$date_file \
		BM201_TEST_DATE_INDEX=$date_index \
		BM201_TEST_DATE_LOG=$date_log \
		BM201_TEST_SLEEP_LOG=$sleep_log \
		_BM201_TEST_ITERATIONS=$test_iterations \
		PATH=$mock_bin:$PATH \
		sh "$program" "$@" > "$stdout_log" 2> "$stderr_log" &
	updater_pid=$!
	if ! printf '%s\n' "$updater_pid" > "$updater_pid_file"; then
		stop_updater
		stop_captures
		printf 'FAIL: could not publish updater process ID\n' >&2
		return 1
	fi
	watchdog_ready_file=$updater_watchdog_ready_file
	watch_processes "$updater_timeout_file" \
		"$updater_watchdog_ready_file" \
		"updater exceeded $lifecycle_timeout-second FIFO lifecycle bound" \
		"$updater_pid" &
	watchdog_pid=$!
	if ! wait_for_watchdog; then
		stop_watchdog
		stop_updater
		stop_captures
		printf 'FAIL: updater FIFO watchdog failed to initialize\n' >&2
		return 1
	fi

	if wait "$updater_pid" 2>/dev/null; then
		run_status=0
	else
		run_status=$?
	fi
	updater_pid=
	stop_watchdog
	finish_captures
	rm -f "$updater_pid_file"

	run_failure=
	capture_failure_file=$capture_failure_dir/first
	if [ -s "$capture_failure_file" ]; then
		IFS= read -r run_failure < "$capture_failure_file" || \
			run_failure="unreadable capture failure report"
	else
		for capture_attribute in text symbols brightness enabled; do
			capture_failure_file=$capture_failure_dir/$capture_attribute
			if [ ! -s "$capture_failure_file" ]; then
				continue
			fi
			IFS= read -r run_failure < "$capture_failure_file" || \
				run_failure="capture $capture_attribute: unreadable failure report"
			break
		done
	fi
	if [ -n "$run_failure" ]; then
		printf 'FAIL: %s\n' "$run_failure" >&2
		return 1
	fi
	if [ -s "$updater_timeout_file" ]; then
		IFS= read -r run_failure < "$updater_timeout_file" || \
			run_failure="unreadable updater timeout report"
		printf 'FAIL: %s\n' "$run_failure" >&2
		return 1
	fi
	if [ -n "$capture_finish_failure" ]; then
		printf 'FAIL: %s\n' "$capture_finish_failure" >&2
		return 1
	fi
}

run_current_case()
{
	run_case_lifecycle "$@" || return $?
	assert_equal 0 "$run_status" "updater exit status"
	if [ -s "$stderr_log" ]; then
		fail "unexpected updater warning: $(cat "$stderr_log")"
	fi
}

assert_initialization()
{
	assert_line_count 1 "$writes_root/brightness" "brightness initialization"
	assert_content 7 "$writes_root/brightness" "brightness value"
	assert_line_count 1 "$writes_root/enabled" "enabled initialization"
	assert_content 1 "$writes_root/enabled" "enabled value"
}

capture_fail_attribute=text
new_case 0 0
set_dates "1234 11"
reader_failure_stderr=$case_root/reader-failure-stderr
if run_case_lifecycle "" --once 2> "$reader_failure_stderr"; then
	reader_failure_status=0
else
	reader_failure_status=$?
fi
capture_fail_attribute=
assert_equal 1 "$reader_failure_status" \
	"forced capture-reader failure status"
assert_line_count 1 "$reader_failure_stderr" \
	"forced capture-reader failure diagnostic"
assert_content 'FAIL: capture text: forced reader failure' \
	"$reader_failure_stderr" "forced capture-reader failure diagnostic"
if [ -e "$updater_timeout_file" ]; then
	fail "forced capture-reader failure reached the lifecycle watchdog"
fi

for carriers in 00 10 01 11; do
	case $carriers in
		00)
			carrier_off=0x04
			carrier_on=0x94
			;;
		10)
			carrier_off=0x0d
			carrier_on=0x9d
			;;
		01)
			carrier_off=0x64
			carrier_on=0xf4
			;;
		11)
			carrier_off=0x6d
			carrier_on=0xfd
			;;
	esac
	eth_carrier=${carriers%?}
	wifi_carrier=${carriers#?}

	new_case "$eth_carrier" "$wifi_carrier"
	set_dates "1234 11"
	run_current_case "" --once
	assert_line_count 1 "$writes_root/text" "colon-off digit write"
	assert_content 1234 "$writes_root/text" "colon-off digits"
	assert_line_count 1 "$writes_root/symbols" "colon-off symbol write"
	assert_content "$carrier_off" "$writes_root/symbols" \
		"colon-off mask for carriers $carriers"
	assert_initialization

	new_case "$eth_carrier" "$wifi_carrier"
	set_dates "1234 12"
	run_current_case "" --once
	assert_line_count 1 "$writes_root/symbols" "colon-on symbol write"
	assert_content "$carrier_on" "$writes_root/symbols" \
		"colon-on mask for carriers $carriers"
	assert_initialization
done

new_case 0 0
set_dates "0708 11" "0709 13"
run_current_case 2
expected_text='0708
0709'
assert_line_count 2 "$writes_root/text" "minute-change digit writes"
assert_content "$expected_text" "$writes_root/text" \
	"zero-padded minute transition"
assert_line_count 1 "$writes_root/symbols" \
	"unchanged symbol suppression across minute change"
assert_content 0x04 "$writes_root/symbols" "minute-change symbol mask"
assert_line_count 1 "$sleep_log" "one-second loop delay"
assert_content 1 "$sleep_log" "loop delay value"
assert_initialization

new_case 1 1
set_dates "0042 11" "0042 11"
run_current_case 2
assert_line_count 1 "$writes_root/text" "unchanged digit suppression"
assert_content 0042 "$writes_root/text" "zero-padded unchanged digits"
assert_line_count 1 "$writes_root/symbols" "unchanged symbol suppression"
assert_content 0x6d "$writes_root/symbols" "unchanged symbol value"
assert_line_count 2 "$date_log" "two deterministic updates"
assert_line_count 1 "$sleep_log" "delay between identical updates"
assert_initialization

# The current mainline time reconciler publishes the timezone at runtime.
new_case 0 0
set_dates "0815 11"
BM201_TIMEZONE_FILE=$test_tmp/timezone
BM201_TEST_TZ_LOG=$test_tmp/timezone-log
export BM201_TIMEZONE_FILE BM201_TEST_TZ_LOG
printf 'Asia/Shanghai\n' > "$BM201_TIMEZONE_FILE"
run_current_case "" --once
assert_content Asia/Shanghai "$BM201_TEST_TZ_LOG" "runtime timezone reaches date"
rm -f "$BM201_TIMEZONE_FILE" "$BM201_TEST_TZ_LOG"
new_case 0 0
set_dates "0816 11"
TZ=UTC
export TZ
run_current_case "" --once
assert_content UTC "$BM201_TEST_TZ_LOG" "missing runtime timezone preserves the process timezone"
unset BM201_TIMEZONE_FILE BM201_TEST_TZ_LOG TZ

missing_root=$test_tmp/missing-panel
missing_net=$test_tmp/missing-net
missing_dates=$test_tmp/missing-dates
missing_date_index=$test_tmp/missing-date-index
missing_date_log=$test_tmp/missing-date-log
missing_sleep_log=$test_tmp/missing-sleep-log
missing_stdout=$test_tmp/missing-stdout
missing_stderr=$test_tmp/missing-stderr
unrelated_file=$test_tmp/unrelated
mkdir -p "$missing_net/eth0" "$missing_net/p2p0"
printf '1\n' > "$missing_net/eth0/carrier"
printf '1\n' > "$missing_net/p2p0/carrier"
printf '2359 58\n' > "$missing_dates"
printf '1\n' > "$missing_date_index"
: > "$missing_date_log"
: > "$missing_sleep_log"
printf 'unchanged\n' > "$unrelated_file"

if BM201_PANEL_ROOT=$missing_root \
	BM201_NET_ROOT=$missing_net \
	BM201_TEST_DATE_FILE=$missing_dates \
	BM201_TEST_DATE_INDEX=$missing_date_index \
	BM201_TEST_DATE_LOG=$missing_date_log \
	BM201_TEST_SLEEP_LOG=$missing_sleep_log \
	PATH=$mock_bin:$PATH \
	sh "$program" --once > "$missing_stdout" 2> "$missing_stderr"; then
	missing_status=0
else
	missing_status=$?
fi
assert_equal 0 "$missing_status" "missing-panel exit status"
assert_line_count 1 "$missing_stderr" "missing-panel warning"
assert_content 'bm201-front-panel: panel controls unavailable' \
	"$missing_stderr" "missing-panel warning text"
assert_line_count 0 "$missing_date_log" "missing-panel date side effect"
assert_content unchanged "$unrelated_file" "missing-panel unrelated file"
assert_content 1 "$missing_net/eth0/carrier" "missing-panel Ethernet carrier"
assert_content 1 "$missing_net/p2p0/carrier" "missing-panel Wi-Fi carrier"
if [ -e "$missing_root" ]; then
	fail "missing panel root was created"
fi

unknown_stderr=$test_tmp/unknown-stderr
if BM201_PANEL_ROOT=$missing_root BM201_NET_ROOT=$missing_net \
	PATH=$mock_bin:$PATH sh "$program" --unknown 2> "$unknown_stderr"; then
	unknown_status=0
else
	unknown_status=$?
fi
assert_equal 2 "$unknown_status" "unknown-argument exit status"
assert_line_count 1 "$unknown_stderr" "unknown-argument diagnostic"

printf 'bm201-front-panel tests: PASS\n'
