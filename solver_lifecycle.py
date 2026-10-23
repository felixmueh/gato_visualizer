"""Linux child-process lifetime guards; intentionally no numerical imports."""
import ctypes
import os
import signal
import threading
import time


def arm_parent_death_signal(expected_parent):
    """Terminate even inside native work if the coordinating process exits.

    The kernel sends the signal when the thread that started this child exits,
    so only children started from a thread that lives as long as its process
    (or its service) may use it."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    # Parent exit before prctl is otherwise missed. The PID was captured by
    # the coordinator before Popen, not guessed after the child was scheduled.
    if os.getppid() != expected_parent:
        os.kill(os.getpid(), signal.SIGTERM)


def exit_with_parent(expected_parent, interval_s=.5):
    """Exit when the parent process is gone, even after SIGKILL.

    For multiprocessing children, which HTTP handler threads may start: a
    daemon thread polls the parent instead of the per-thread death signal.
    Children of this process that arm the death signal follow it."""
    def watch():
        while os.getppid() == expected_parent:
            time.sleep(interval_s)
        os._exit(1)
    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


def run_with_parent(expected_parent, target, *args):
    """Multiprocessing target: target(*args) in a child that exits with its parent."""
    exit_with_parent(expected_parent)
    return target(*args)
