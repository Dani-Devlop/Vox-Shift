#!/usr/bin/env python3
"""Railway SSH gateway poller (paramiko-based; sandbox has no openssh client).
Polls every 10 s until the workspace SSH key is accepted, then runs a mini audit.
Exit 0 = connected+audited, 2 = window ended still denied, 1 = unexpected."""
import sys, time
import paramiko

HOSTS = ["ssh.railway.com", "ssh.railway.app"]
USERS = [
    "docker-ubuntu-free-production-7e72.up.railway.app",  # actual service domain
    "test-production.up.railway.app",                     # doc-example fallback
]
KEY = "/home/z/.ssh/zack"
MAX_ATTEMPTS = 20
AUDIT_CMD = (
    "echo CONNECTED_OK; hostname; whoami; uname -a; head -3 /etc/os-release; "
    "echo -n 'cpus: '; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; "
    "free -h | head -2; df -h / | tail -1; "
    "grep -m1 'model name' /proc/cpuinfo || true; "
    "for c in python3 docker git curl ffmpeg ollama node bun sshd; do "
    "command -v $c >/dev/null 2>&1 && echo \"$c: YES\" || echo \"$c: no\"; done"
)

def attempt(host, user, audit=True, timeout=12):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        c.connect(host, 22, username=user, key_filename=KEY,
                  look_for_keys=False, allow_agent=False,
                  timeout=timeout, banner_timeout=20, auth_timeout=20)
        if not audit:
            return True, "auth-ok"
        _stdin, stdout, stderr = c.exec_command(AUDIT_CMD, timeout=30)
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        return True, out + (("\n[stderr]\n" + err) if err.strip() else "")
    except paramiko.AuthenticationException:
        return False, "auth-denied (key not active yet)"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    finally:
        try:
            c.close()
        except Exception:
            pass

def main():
    for i in range(1, MAX_ATTEMPTS + 1):
        for host in HOSTS:
            for user in USERS:
                ok, msg = attempt(host, user)
                ts = time.strftime("%H:%M:%S")
                if ok:
                    print(f"[{ts}] SUCCESS via {user}@{host} (attempt {i})")
                    print(msg)
                    return 0
                print(f"[{ts}] attempt {i:02d} {user}@{host} -> {msg}", flush=True)
                if not msg.startswith("auth-denied"):
                    break  # network-level problem: stop hammering fallbacks this round
        time.sleep(10)
    print("POLL_WINDOW_ENDED_STILL_DENIED")
    return 2

if __name__ == "__main__":
    sys.exit(main())
