"""Linux solver-child lifetime guard; intentionally no numerical imports."""
import ctypes
import os
import signal


def arm_parent_death_signal(expected_parent):
    """Terminate even inside native work if the coordinating process exits."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    # Parent exit before prctl is otherwise missed. The PID was captured by
    # the coordinator before Popen, not guessed after the child was scheduled.
    if os.getppid() != expected_parent:
        os.kill(os.getpid(), signal.SIGTERM)
