import { NextRequest, NextResponse } from 'next/server'
import { readFile, appendFile } from 'fs/promises'
import { existsSync, readdirSync, realpathSync, openSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ─────────────────────────────────────────────────────────────────────────────
// Mini-service supervisor (dev/deployment control plane).
//
// POST /api/dev-services  { service: 'translator', action: 'restart' | 'status' }
// header: x-service-token — MUST match db/.service-token (generated on first
// boot server-side; never served to clients).
//
// Why: bun --hot's file watcher can silently die, leaving a mini-service on
// STALE code (observed 2026-10-09). This endpoint restarts the service as a
// CHILD OF THE NEXT.JS PROCESS so its lifetime matches the app server — no
// orphan reaping, no manual shell work. On a production box the same effect
// comes from systemd/nohup; this endpoint keeps the sandbox and dev machines
// honestly operable. Actions are real: a /proc cwd scan + a real spawn.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICES: Record<string, { cwd: string; log: string; port: number }> = {
  translator: {
    cwd: path.join(process.cwd(), 'mini-services', 'translator-service'),
    log: path.join(process.cwd(), 'translator-service.log'),
    port: 3003,
  },
}

async function tokenOk(req: NextRequest): Promise<boolean> {
  const provided = req.headers.get('x-service-token') ?? ''
  if (!provided) return false
  try {
    const stored = (await readFile(path.join(process.cwd(), 'db', '.service-token'), 'utf8')).trim()
    return stored.length > 16 && provided === stored
  } catch {
    return false
  }
}

/** Find PIDs of processes whose cwd is the service dir (real /proc scan). */
function findServicePids(cwd: string): number[] {
  const pids: number[] = []
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const real = realpathSync(`/proc/${entry}/cwd`)
        if (real === cwd) pids.push(Number(entry))
      } catch {
        /* cwd unreadable (permission/gone) */
      }
    }
  } catch {
    /* /proc unavailable */
  }
  return pids
}

export async function POST(req: NextRequest) {
  if (!(await tokenOk(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = (await req.json().catch(() => null)) as { service?: string; action?: string } | null
  const svc = body?.service ?? ''
  const action = body?.action ?? 'status'
  const conf = SERVICES[svc]
  if (!conf) return NextResponse.json({ error: `Unknown service '${svc}'` }, { status: 400 })

  if (action === 'status') {
    const pids = findServicePids(conf.cwd)
    return NextResponse.json({ service: svc, pids, running: pids.length > 0 })
  }

  if (action !== 'restart') {
    return NextResponse.json({ error: 'action must be restart or status' }, { status: 400 })
  }

  try {
    // 1) Kill existing processes for this service (old watcher may be dead).
    const old = findServicePids(conf.cwd)
    for (const pid of old) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    // Give them a moment, then SIGKILL survivors.
    await new Promise((r) => setTimeout(r, 1500))
    for (const pid of findServicePids(conf.cwd)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }

    // 2) Spawn fresh — a CHILD of this Next.js process (lifetime matches the
    // app server; survives independently of the request that spawned it).
    const fd = openSync(conf.log, 'a')
    const child = spawn('bun', ['run', 'dev'], {
      cwd: conf.cwd,
      stdio: ['ignore', fd, fd],
      env: { ...process.env },
    })
    child.unref()

    // 3) Real health check: wait for the socket.io port to answer.
    const t0 = Date.now()
    let healthy = false
    while (Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 700))
      try {
        const res = await fetch(`http://127.0.0.1:${conf.port}/`, {
          signal: AbortSignal.timeout(1500),
        })
        // socket.io answers GET / with 400 + engine.io error json when healthy
        if (res.status === 400 || res.ok) {
          healthy = true
          break
        }
      } catch {
        /* not up yet */
      }
    }

    await appendFile(
      conf.log,
      `\n[supervisor] restart via API at ${new Date().toISOString()} — old pids [${old.join(', ')}], new pid ${child.pid}, healthy=${healthy}\n`
    ).catch(() => {})

    return NextResponse.json({
      ok: healthy,
      service: svc,
      oldPids: old,
      newPid: child.pid,
      healthy,
      ms: Date.now() - t0,
    })
  } catch (err) {
    console.error('[dev-services] restart failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'restart failed' }, { status: 500 })
  }
}
