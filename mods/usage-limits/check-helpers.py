"""Safe helper lifetime regression: only a native Python stand-in is launched.
Run: python mods/usage-limits/check-helpers.py [path-to-sh]
"""
import ctypes
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time


def alive(pid):
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
        kernel.CloseHandle(ctypes.c_void_p(handle))
        return code.value == 259
    try:
        stat = Path(f'/proc/{pid}/stat')
        if stat.exists() and stat.read_text().split(') ', 1)[1].startswith('Z '):
            return False
        os.kill(pid, 0)
        return True
    except (FileNotFoundError, ProcessLookupError):
        return False


def stop(pid):
    if not alive(pid):
        return
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(1, False, pid)
        if handle:
            kernel.TerminateProcess(ctypes.c_void_p(handle), 1)
            kernel.CloseHandle(ctypes.c_void_p(handle))
    else:
        os.kill(pid, signal.SIGKILL)


root = Path(__file__).resolve().parent
sh = sys.argv[1] if len(sys.argv) > 1 else ('C:/Program Files/Git/bin/sh.exe' if os.name == 'nt' else 'sh')
with tempfile.TemporaryDirectory(prefix='usage-helper-check-') as temporary:
    scratch = Path(temporary)
    (scratch / 'sessions').mkdir()
    (scratch / 'sessions' / 'snapshot.jsonl').write_text('{"rate_limits":{"primary":{"used_percent":12}}}\n')
    mock = scratch / 'mock.py'
    mock.write_text('''import os, sys, time, subprocess
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
Path(os.environ['MOCK_PID']).write_text(str(os.getpid()) + ' ' + str(child.pid))
for line in sys.stdin:
    if 'get_usage' in line or '"id":2' in line:
        if os.environ['MOCK_REPLY'] == 'yes':
            print('{"type":"control_response","id":2,"result":{"ok":true}}', flush=True)
# Stay alive after EOF, as a CLI draining outstanding requests can do.
time.sleep(30)
''', newline='\n')
    launcher = scratch / 'mock-cli'
    command = shlex.quote(Path(sys.executable).as_posix()) + ' ' + shlex.quote(mock.as_posix()) + ' "$@"'
    # Unix npm-style shims stay alive and forward TERM to the real binary.
    launch = ('exec ' + command + '\n') if os.name == 'nt' else ('exec 3<&0\n' + command + ' <&3 3<&- &\nchild=$!\nexec 3<&-\ntrap \'kill -TERM "$child" 2>/dev/null\' TERM\nwait "$child"\n')
    launcher.write_text('#!/bin/sh\n' + launch, newline='\n')
    launcher.chmod(0o755)
    for name in ['claude-usage.sh', 'codex-limits.sh', 'codex-reset.sh']:
        source = root / 'helpers' / name
        if not source.exists():
            continue
        script = source.read_text()
        budget = '150' if name == 'codex-reset.sh' else '75'
        assert f'"$i" -lt {budget}' in script, name
        # Only scratch copies shorten polling. Production retains 15/30 seconds.
        helper = scratch / name
        helper.write_text(script.replace(f'"$i" -lt {budget}', '"$i" -lt 10'), newline='\n')
        for reply in ['yes', 'no']:
            pid_file = scratch / 'pid'
            pid_file.unlink(missing_ok=True)
            env = dict(os.environ, MOCK_PID=pid_file.as_posix(), MOCK_REPLY=reply,
                       HERDR_USAGE_CLAUDE_BIN=launcher.as_posix(), HERDR_USAGE_CODEX_BIN=launcher.as_posix(),
                       CODEX_HOME=scratch.as_posix())
            started = time.monotonic()
            try:
                result = subprocess.run([sh, helper.as_posix(), 'test-key'], env=env,
                                        capture_output=True, text=True, timeout=20)
                elapsed = time.monotonic() - started
                assert pid_file.exists(), (name, reply, elapsed, result)
                pid, descendant = map(int, pid_file.read_text().split())
                assert elapsed < 20, (name, reply, 'waited for post-EOF cleanup', elapsed)
                assert not alive(pid), (name, reply, 'child survived helper exit', pid)
                assert not alive(descendant), (name, reply, 'native descendant survived', descendant)
                expected = 0 if reply == 'yes' or name == 'codex-limits.sh' else 1
                assert result.returncode == expected, (name, reply, result)
                if reply == 'yes':
                    assert '"result"' in result.stdout, result
                elif name == 'codex-limits.sh':
                    assert '"snapshot"' in result.stdout, result
                print(f'{name} reply={reply}: {elapsed:.2f}s, exit={result.returncode}, child reaped', flush=True)
            finally:
                if pid_file.exists():
                    for pid in map(int, pid_file.read_text().split()):
                        stop(pid)
print('helper lifetime checks passed')
