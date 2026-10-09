#!/usr/bin/env python3
"""Tiny SSH/SFTP CLI for the Railway box (paramiko-based; sandbox has no openssh binaries).
Usage:
  python3 rssh.py exec "COMMAND" [TIMEOUT_S]
  python3 rssh.py put LOCAL REMOTE
Exit code mirrors the remote command's exit status for exec."""
import sys
import paramiko

HOST, PORT, KEY = "ssh.railway.com", 22, "/home/z/.ssh/zack"
USER = "docker-ubuntu-free-production-7e72.up.railway.app"


def client(timeout=15):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, PORT, username=USER, key_filename=KEY, look_for_keys=False,
              allow_agent=False, timeout=timeout, banner_timeout=25, auth_timeout=25)
    return c


def main():
    if len(sys.argv) < 3:
        print("usage: rssh.py exec CMD [TIMEOUT_S] | put LOCAL REMOTE", file=sys.stderr)
        return 1
    mode, arg = sys.argv[1], sys.argv[2]
    c = client()
    try:
        if mode == "exec":
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 120
            _stdin, stdout, stderr = c.exec_command(arg, timeout=timeout)
            out = stdout.read().decode(errors="replace")
            err = stderr.read().decode(errors="replace")
            rc = stdout.channel.recv_exit_status()
            sys.stdout.write(out)
            if err.strip():
                sys.stderr.write("\n[stderr]\n" + err)
            return rc
        if mode == "put":
            sftp = c.open_sftp()
            sftp.put(arg, sys.argv[3])
            st = sftp.stat(sys.argv[3])
            print(f"UPLOADED {sys.argv[3]} ({st.st_size} bytes)")
            sftp.close()
            return 0
        print("unknown mode", file=sys.stderr)
        return 1
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
