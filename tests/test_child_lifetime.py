"""Multiprocessing children exit with their parent, even after SIGKILL (Linux)."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import textwrap
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

PARENT = textwrap.dedent("""
    import multiprocessing as mp, os, sys, threading, time
    sys.path.insert(0, sys.argv[1])
    from solver_lifecycle import run_with_parent

    def start():  # like a plot-worker restart from a short-lived HTTP handler thread
        child = mp.get_context("spawn").Process(target=run_with_parent, args=(os.getpid(), time.sleep, 60), daemon=True)
        child.start()
        print(child.pid, flush=True)

    if __name__ == "__main__":
        thread = threading.Thread(target=start)
        thread.start(); thread.join()
        time.sleep(60)
""")


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as stat:
            return stat.read().split()[2] != "Z"
    except FileNotFoundError:
        return False


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux process lifetime")
class ChildLifetimeTests(unittest.TestCase):
    def test_a_child_started_from_an_ended_thread_lives_until_its_parent_is_killed(self):
        parent = subprocess.Popen([sys.executable, "-c", PARENT, str(ROOT)], stdout=subprocess.PIPE, text=True)
        try:
            child = int(parent.stdout.readline())
            time.sleep(1.5)  # the thread that started it has ended
            self.assertTrue(alive(child))
            os.kill(parent.pid, signal.SIGKILL)
            parent.wait(timeout=5)
            deadline = time.monotonic() + 5
            while alive(child) and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertFalse(alive(child), "child survived its killed parent")
        finally:
            parent.kill()
            parent.wait()
            parent.stdout.close()


if __name__ == "__main__":
    unittest.main()
