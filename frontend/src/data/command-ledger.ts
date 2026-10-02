// 出动命令台账（纯前端版「命令中心」）：
// 纯前端没有真正的唯一约束和行锁，用 localStorage 模拟两件事——
// 1. 接令时序：同一支队伍的出动命令先到先受理，后到的冲突命令按接令时间驳回；
// 2. 幂等占坑：两台终端对同一动作的重复提交共享一把锁，只允许其中一台落库。
const LEDGER_KEY = 'forest-fire-patrol:dispatch-ledger:v1'
const TTL_MS = 30_000

export type LedgerClaim = {
  fingerprint: string
  scope: string
  owner: string
  ownerFarm: string
  createdAt: number
}

function readLedger(): LedgerClaim[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as LedgerClaim[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLedger(claims: LedgerClaim[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const now = Date.now()
  const fresh = claims.filter((claim) => now - claim.createdAt < TTL_MS)
  window.localStorage.setItem(LEDGER_KEY, JSON.stringify(fresh))
}

// 原子占坑：指纹相同视为同一笔提交（重复点击/两台终端同时提交），只有第一笔拿到受理权。
export function acquire(fingerprint: string, owner: Operator): { acquired: boolean; claim?: LedgerClaim } {
  const claims = readLedger()
  const existed = claims.find((claim) => claim.fingerprint === fingerprint)
  if (existed) {
    return { acquired: false, claim: existed }
  }
  const claim: LedgerClaim = {
    fingerprint,
    scope: owner.scope,
    owner: owner.operator,
    ownerFarm: owner.farm,
    createdAt: Date.now(),
  }
  writeLedger([...claims, claim])
  return { acquired: true, claim }
}

// 查询某个业务作用域（如某支队伍的出动）当前占坑的首条命令，用于说明冲突时是谁先接令。
export function firstClaim(scope: string): LedgerClaim | undefined {
  return readLedger()
    .filter((claim) => claim.scope === scope)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

type Operator = {
  scope: string
  operator: string
  farm: string
}
