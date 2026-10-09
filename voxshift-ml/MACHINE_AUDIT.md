# VoxShift v3.1 — Machine Audit Report (ACTUAL, via Channel A)

Audit date: 2026-10-09 17:23 UTC (server clock) · Method: Channel A command API (17-command whitelist, no shell/pipes — verified empirically)
Every value below is **LOCAL / ACTUAL** (measured), not estimated.

## 1. OS / Environment
| Item | Actual value | Label |
|---|---|---|
| OS (container) | Ubuntu 22.04.5 LTS (Jammy) | ACTUAL |
| Kernel | 6.18.15+deb13-cloud-amd64 (host kernel, Debian backport) | ACTUAL |
| Hostname | 5fcee54181ef (Docker-style container ID) | ACTUAL |
| User | root | ACTUAL |
| Virtualization | Container on shared cloud host (overlay fs, `hypervisor`, `svm` flags) | ACTUAL |
| Uptime (host) | 133 days | ACTUAL |
| GPU | **NONE** (`find /dev -name nvidia*` → empty; no /dev/dri) | ACTUAL |

## 2. CPU
| Item | Actual value | Label |
|---|---|---|
| Model | **AMD EPYC 9655P 96-Core Processor** (family 26, model 2 → Zen 5 / Turin) | ACTUAL |
| Visible logical CPUs | **48** (cgroup-limited slice of the 96-core host) | ACTUAL |
| Claimed "42 physical cores" | **MISMATCH** — actual assignment is 48 vCPU; physical core count not observable from container. Use 48 vCPU as benchmark target. | CORRECTED |
| Base clock | 2600 MHz | ACTUAL |
| AVX2 | ✅ yes | ACTUAL |
| AVX-512 | ✅ full suite: f, dq, ifma, cd, bw, vl, vbmi, vbmi2, bitalg, vpopcntdq, vp2intersect | ACTUAL |
| AVX-VNNI / AVX512-VNNI | ✅ both (INT8 dot-product acceleration → CTranslate2/ONNX Runtime benefit) | ACTUAL |
| AVX512-BF16 | ✅ yes (BF16 fast path available) | ACTUAL |
| VAES / GFNI / SHA-NI | ✅ present | ACTUAL |
| NUMA nodes visible | 1 (`/sys/devices/system/node/possible` = `0`) | ACTUAL |

## 3. RAM / Disk
| Item | Actual value | Label |
|---|---|---|
| Total RAM (host) | 322 GiB | ACTUAL |
| **Available** RAM | **89 GiB** (213 GiB used by co-tenants) | ACTUAL |
| Claimed "~100 GB RAM" | Roughly consistent with available memory; use **89 GiB** as planning budget | CORRECTED |
| Swap | 223 GiB configured, 2.6 GiB used | ACTUAL |
| Disk | overlay 2.9 TB total, **1.8 TB free** (39% used) | ACTUAL |

## 4. Load / Noise (benchmark validity)
| Item | Actual value | Label |
|---|---|---|
| Load average | 20.90 / 20.40 / 19.44 on 48 vCPU (~43% busy) | ACTUAL |
| Co-tenancy | Shared host with other workloads → **noisy-neighbor risk**; every benchmark MUST record load before/after and repeat unstable runs | ACTUAL |

## 5. Installed software (relevant)
| Item | Actual value | Label |
|---|---|---|
| Python | 3.10 (`/usr/bin/python3.10`, `python3`) | ACTUAL |
| pip3 standalone | not found (use `python3 -m pip` / venv; may need `apt install python3.10-venv`) | ACTUAL |
| ffmpeg | not found (not required by selected stack) | ACTUAL |
| Docker/Podman | not found in /usr/bin | ACTUAL |
| Ollama | `/usr/local/bin/ollama` ✅ | ACTUAL |
| Ollama models | **qwen2.5:3b-instruct only** (manifest at `/root/.ollama/models/manifests/registry.ollama.ai/library/qwen2.5/3b-instruct`) | ACTUAL |

## 6. VoxShift project on server
| Item | Actual value | Label |
|---|---|---|
| Repo path | `/root/Desktop/Vox-Shift` (git clone present, node_modules + .next built) | ACTUAL |
| ML stack | **NOT INSTALLED** — no `ml/`, no `requirements*`, no `*.py` anywhere in repo | ACTUAL |
| Repo contents | src/, mini-services/, prisma/, tests/, cloudflared/, .env, dev.log, worklog.md | ACTUAL |
| Channel B (web app tunnel) | **502 Bad gateway — DOWN at audit time** | ACTUAL |

## 7. Channel A behavior notes (empirical)
- Executes commands **without a shell**: pipes (`a | b`), shell globs and quoting are NOT processed (verified: `top -bn1 | head -12` → exit 1; `grep 'model name' …` → exit 2).
- Single commands with direct file arguments work correctly (`head N file`, `grep -mN pat file`, `find … -name pat`).
- Impact: audit commands must be shell-free; nothing beyond the 17 whitelisted commands is possible (read-only audit — installation/benchmarking must be executed by the user in their own terminal).
