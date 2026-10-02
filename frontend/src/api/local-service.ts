import { MODULE_BY_KEY } from '@/data/modules'
import { acquire, firstClaim } from '@/data/command-ledger'
import { allRows, listRows, refreshRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OperatorContext,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 只有队伍所属林场的值班人员才能改动的受保护字段
const TEAM_PROTECTED_FIELDS = ['队伍编号', '队长姓名', '集结半径']
const TEAM_KEY = 'fireteam'
const FIRE_REPORT_KEY = 'firereport'
const DISPATCH_ACTION = '下达出动'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function nowText(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function clockText(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function deny(message: string): ActionResult {
  return { ok: false, message }
}

// 林场权限边界：只有队伍「当前所属林场」的值班人员能写，其它林场一律拦截
// （调岗改的是当前所属林场，历史归属林场保持不变，越权判断始终看当前归属）。
function canManageTeam(team: EntryRow, operator: OperatorContext): boolean {
  return String(team['所属林场'] ?? '') === operator.farm
}

// 扑火队伍动作入口：权限边界、接令时间仲裁、幂等占坑、出动后联动火情报告都走这里。
export function runTeamAction(
  id: number,
  action: string,
  operator: OperatorContext,
): ActionResult {
  const meta = moduleMeta(TEAM_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return deny(`扑火队伍没有登记「${action}」这个动作`)
  }

  // 落库前强制重读，避免本终端缓存覆盖另一终端已提交的数据
  refreshRows()
  const rows = listRows(TEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return deny(`没有找到编号为 ${id} 的扑火队伍`)
  }
  const team = rows[index]

  if (!canManageTeam(team, operator)) {
    return deny(
      `越权拦截：${team['队伍编号']} 归属「${team['所属林场']}」，${operator.farm}值班人员只能查看，不能执行「${action}」`,
    )
  }

  const teamScope = `fireteam:${id}:${action}`
  // 指纹不带毫秒、带林场：两台终端/两个标签页对同一队伍同一动作的重复提交只受理一笔
  const fingerprint = `${teamScope}@${Math.floor(Date.now() / 1000)}`
  const claim = acquire(fingerprint, {
    scope: teamScope,
    operator: operator.operator,
    farm: operator.farm,
  })
  if (!claim.acquired && claim.claim) {
    return {
      ok: true,
      duplicated: true,
      message: `该确认已由${claim.claim.ownerFarm}「${claim.claim.owner}」于 ${clockText(
        claim.claim.createdAt,
      )} 提交落库，本次为重复提交，不再重复落库`,
    }
  }

  const current = String(team.status)

  // 冲突出动命令按接令时间处理：同队已有先受理的出动命令时，后到命令一律驳回。
  // 放在状态校验之前——哪怕队伍已出动，也要给出「谁先接令」的冲突结论，而不是笼统的重复操作。
  if (action === DISPATCH_ACTION) {
    const first = firstClaim(`fireteam:${id}:${DISPATCH_ACTION}`)
    if (first && first.fingerprint !== fingerprint) {
      return deny(
        `出动命令冲突：队伍 ${team['队伍编号']} 的出动已按接令时间受理首条命令（${first.ownerFarm}「${first.owner}」于 ${clockText(
          first.createdAt,
        )} 接令），后到命令不予受理`,
      )
    }
  }

  if (current === target) {
    return deny(`队伍已经是「${target}」状态，不用重复操作`)
  }

  const receivedAt = action === DISPATCH_ACTION ? nowText() : String(team['接令时间'] ?? '')
  const updated: EntryRow = {
    ...team,
    status: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    接令时间: receivedAt,
    出动状态: target,
  }
  const nextTeams = [...rows]
  nextTeams[index] = updated
  saveRows(TEAM_KEY, nextTeams)

  if (action === DISPATCH_ACTION) {
    appendPendingFireReport(updated, receivedAt)
  }
  return {
    ok: true,
    message:
      action === DISPATCH_ACTION
        ? `出动确认成功：${updated['队伍编号']} 已出动（接令时间 ${receivedAt}），火情报告待出警清单已新增一份`
        : `队伍已${action}，当前状态「${target}」`,
  }
}

// 出动确认后，其它入口（火情报告模块）的待出警清单一并新增一份；
// 台账占坑保证两台终端同时确认时这里也只会追加一份。
function appendPendingFireReport(team: EntryRow, receivedAt: string): void {
  refreshRows()
  const reports = listRows(FIRE_REPORT_KEY)
  const teamCode = String(team['队伍编号'] ?? '')
  // 兜底去重：同一接令时间 + 同一队伍编号只允许一份待出警报告
  const duplicated = reports.some(
    (row) =>
      String(row.status) === '待出警' &&
      String(row['关联队伍编号'] ?? '') === teamCode &&
      String(row['起火时间'] ?? '') === receivedAt,
  )
  if (duplicated) {
    return
  }
  const nextId = reports.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const stamp = receivedAt.replace(/[-: ]/g, '').slice(0, 12)
  const report: EntryRow = {
    id: nextId,
    status: '待出警',
    pending: true,
    abnormal: false,
    报告编号: `FRPT-${stamp}-${String(nextId).padStart(2, '0')}`,
    起火地点: `${team['所属林场']}辖区（${team['队伍名称']}出动确认联动生成）`,
    起火时间: receivedAt,
    火势等级: '待核定',
    过火面积: '待核定',
    扑救情况: '队伍已出动，待出警处置',
    报告人: `出动联动·${team['队伍名称']}`,
    关联队伍编号: teamCode,
  }
  saveRows(FIRE_REPORT_KEY, [...reports, report])
}

// 改动受保护字段（队伍编号、队长姓名、集结半径）：数据层强制林场边界，绕过页面也拦得住。
export function updateTeamProfile(
  id: number,
  patch: { 队伍编号: string; 队长姓名: string; 集结半径: string },
  operator: OperatorContext,
): ActionResult {
  for (const [field, value] of Object.entries(patch)) {
    if (!value.trim()) {
      return deny(`「${field}」不能为空`)
    }
  }
  refreshRows()
  const rows = listRows(TEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return deny(`没有找到编号为 ${id} 的扑火队伍`)
  }
  const team = rows[index]
  if (!canManageTeam(team, operator)) {
    return deny(
      `越权拦截：队伍编号、队长姓名、集结半径仅归属林场（${team['所属林场']}）值班人员可改，${operator.farm}只读`,
    )
  }
  const next = [...rows]
  next[index] = { ...team, ...patch }
  saveRows(TEAM_KEY, next)
  return { ok: true, message: `队伍 ${patch.队伍编号} 的登记信息已更新（${operator.farm}值班台提交）` }
}

// 跨林场调岗：只改当前所属林场并留痕，历史归属林场保持建队时的原林场不变。
export function transferTeam(
  id: number,
  targetFarm: string,
  operator: OperatorContext,
): ActionResult {
  refreshRows()
  const rows = listRows(TEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return deny(`没有找到编号为 ${id} 的扑火队伍`)
  }
  const team = rows[index]
  if (!canManageTeam(team, operator)) {
    return deny(
      `越权拦截：调岗需队伍当前归属林场（${team['所属林场']}）值班人员发起，${operator.farm}只读`,
    )
  }
  const fromFarm = String(team['所属林场'] ?? '')
  if (targetFarm === fromFarm) {
    return deny(`队伍已归属「${targetFarm}」，无需调岗`)
  }
  const record = `${nowText()} ${fromFarm} → ${targetFarm}（${operator.operator}发起调岗；历史归属仍记${team['历史归属林场']}）`
  const history = String(team['归属变更记录'] ?? '')
  const next = [...rows]
  next[index] = {
    ...team,
    所属林场: targetFarm,
    归属变更记录: history ? `${history}\n${record}` : record,
  }
  saveRows(TEAM_KEY, next)
  return {
    ok: true,
    message: `队伍 ${team['队伍编号']} 已调岗至「${targetFarm}」；历史归属仍为「${team['历史归属林场']}」`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
