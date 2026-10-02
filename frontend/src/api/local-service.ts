import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, readMeta, resetRows, saveRows, writeMeta } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const FIRETEAM_KEY = 'fireteam'
const FIREREPORT_KEY = 'firereport'
// 已在外执行任务的队伍不能再接第二张出动命令（冲突按接令时间拦截）。
const DEPLOYED_STATUSES = ['已出动', '扑救中']
// 两台终端同时提交的去重窗口（毫秒）：窗口内同一队伍的「下达出动」只落库一次。
const DISPATCH_DEDUP_MS = 3000
const DISPATCH_LEDGER_KEY = 'dispatchLedger'
const LAST_FIRETEAM_ID_KEY = 'lastFireteamId'

type DispatchClaim = { teamId: number; at: number; station: string }
type StationHistoryItem = { 林场: string; 生效时间: string; 原因: string }

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function parseHistory(raw: unknown): StationHistoryItem[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StationHistoryItem[]) : []
  } catch {
    return []
  }
}

// 全部出现过的林场：既有当前归属，也包含调岗前的历史归属，供值班身份切换。
export function listStations(): string[] {
  const stations = new Set<string>()
  for (const row of listRows(FIRETEAM_KEY)) {
    const station = String(row['所属林场'] ?? '').trim()
    if (station) {
      stations.add(station)
    }
    for (const item of parseHistory(row['归属历史'])) {
      if (item.林场) {
        stations.add(item.林场)
      }
    }
  }
  return [...stations].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

// 扑火队伍动作统一入口：页面不做业务判断，权限、冲突、跨模块联动都在这里拦。
export function runFireteamAction(
  id: number,
  action: string,
  operatorStation: string,
): ActionResult {
  if (action === '下达出动') {
    return dispatchFireteam(id, operatorStation)
  }
  const result = runAction(FIRETEAM_KEY, id, action)
  if (!result.ok) {
    return result
  }
  // 撤回 / 休整意味着本次出动闭环：清掉接令信息与去重台账，历史归属快照保留不动。
  if (action === '撤回队伍' || action === '转入休整') {
    const rows = listRows(FIRETEAM_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index >= 0) {
      const next = [...rows]
      next[index] = { ...next[index], 接令时间: '', 接令林场: '' }
      saveRows(FIRETEAM_KEY, next)
    }
    writeMeta(
      DISPATCH_LEDGER_KEY,
      dispatchLedger().filter((item) => item.teamId !== id),
    )
  }
  return result
}

export type TeamPatch = {
  所属林场: string
  队伍编号: string
  队长姓名: string
  集结半径: string
}

// 改动队伍编号 / 队长姓名 / 集结半径（含调岗）：只有本林场值班人员能提交，
// 越权提交在这里直接拦截，页面层的禁用只是少给入口。
export function updateFireteam(
  id: number,
  patch: TeamPatch,
  operatorStation: string,
): ActionResult {
  const rows = listRows(FIRETEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的扑火队伍` }
  }
  const current = rows[index]
  const ownerStation = String(current['所属林场'] ?? '').trim()
  if (!operatorStation || operatorStation !== ownerStation) {
    return {
      ok: false,
      message: `越权拦截：该队伍归属「${ownerStation}」，只有本林场值班人员可改动，当前值班身份为「${operatorStation || '未指定林场'}」`,
    }
  }
  const 队伍编号 = patch.队伍编号.trim()
  const 队长姓名 = patch.队长姓名.trim()
  const 集结半径 = patch.集结半径.trim()
  const 所属林场 = patch.所属林场.trim()
  if (!队伍编号 || !队长姓名 || !集结半径 || !所属林场) {
    return { ok: false, message: '所属林场、队伍编号、队长姓名、集结半径均不能为空' }
  }
  if (!/^\d+(\.\d+)?$/.test(集结半径) || Number(集结半径) <= 0) {
    return { ok: false, message: '集结半径必须是大于 0 的数字（公里）' }
  }
  const duplicated = rows.some(
    (row) => Number(row.id) !== id && String(row['队伍编号']) === 队伍编号,
  )
  if (duplicated) {
    return { ok: false, message: `队伍编号「${队伍编号}」已存在，编号不能重复` }
  }
  const stamp = formatStamp(new Date())
  const history = parseHistory(current['归属历史'])
  if (所属林场 !== ownerStation) {
    // 调岗只追加归属履历，不改写旧记录：队伍的历史归属永远留在原林场。
    history.unshift({ 林场: ownerStation, 生效时间: stamp, 原因: `调岗至「${所属林场}」` })
  }
  const updated: EntryRow = {
    ...current,
    所属林场,
    队伍编号,
    队长姓名,
    集结半径,
    归属历史: JSON.stringify(history),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(FIRETEAM_KEY, next)
  return {
    ok: true,
    message:
      所属林场 !== ownerStation
        ? `队伍信息已更新，并登记调岗：历史归属保留在「${ownerStation}」`
        : '队伍信息已更新',
  }
}

function dispatchLedger(): DispatchClaim[] {
  return readMeta<DispatchClaim[]>(DISPATCH_LEDGER_KEY, [])
}

function dispatchFireteam(teamId: number, operatorStation: string): ActionResult {
  const meta = moduleMeta(FIRETEAM_KEY)
  const rows = listRows(FIRETEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === teamId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${teamId} 的扑火队伍` }
  }
  const team = rows[index]
  const now = Date.now()
  const ledger = dispatchLedger()
  const claim = ledger.find((item) => item.teamId === teamId)

  // 先看跨终端台账：去重窗口内的第二次提交直接识别为重复，不产生任何写入。
  if (claim && now - claim.at <= DISPATCH_DEDUP_MS) {
    return {
      ok: true,
      duplicated: true,
      message: `出动命令已于 ${formatStamp(new Date(claim.at))} 受理（${claim.station}），重复提交已忽略，仅落库一次`,
    }
  }

  // 冲突命令按「接令时间」处理：先受理的命令生效，队伍已在执行任务时后到的命令一律拦截。
  const status = String(team.status)
  if (DEPLOYED_STATUSES.includes(status)) {
    return {
      ok: false,
      message:
        `出动冲突：队伍当前为「${status}」，${String(team['接令时间'] || '此前')}已接令出动；` +
        '按接令时间先到先得，后到的出动命令不予受理',
    }
  }

  const stamp = formatStamp(new Date(now))
  // 先登记受理台账再写业务表：两台终端同时提交时，后写入的那台会命中上面的去重判断。
  writeMeta(DISPATCH_LEDGER_KEY, [...ledger.filter((item) => item.teamId !== teamId), {
    teamId,
    at: now,
    station: operatorStation,
  }])

  const station = String(team['所属林场'] ?? '').trim()
  const updated: EntryRow = {
    ...team,
    status: '已出动',
    pending: true,
    abnormal: false,
    出动状态: '已出动',
    // 接令时刻与接令时的归属林场一起快照，调岗后也不回改。
    接令时间: stamp,
    接令林场: station,
  }
  const nextTeams = [...rows]
  nextTeams[index] = updated
  saveRows(FIRETEAM_KEY, nextTeams)

  // 出动确认后，在火情报告入口的「待出警清单」一并新增一份（同一份火情，不在队伍页重复造单）。
  const reports = listRows(FIREREPORT_KEY)
  const lastId = readMeta<number>(LAST_FIRETEAM_ID_KEY, 0)
  let nextId = lastId
  do {
    nextId += 1
  } while (reports.some((row) => Number(row.id) === nextId))
  const report: EntryRow = {
    id: nextId,
    status: '已确认',
    pending: true,
    abnormal: false,
    报告编号: `REPT-${String(nextId).padStart(4, '0')}`,
    起火地点: `${station}辖区（队伍${String(team['队伍编号'])}出警）`,
    起火时间: stamp,
    火势等级: '待核定',
    过火面积: '待核定',
    扑救情况: `队伍已出动，集结半径 ${String(team['集结半径'])} 公里`,
    报告人: `${operatorStation}值班台`,
    报告状态: '待出警',
    来源入口: '扑火队伍-下达出动',
    关联队伍: String(team['队伍编号']),
    接令林场: station,
  }
  saveRows(FIREREPORT_KEY, [...reports, report])
  writeMeta(LAST_FIRETEAM_ID_KEY, nextId)

  return {
    ok: true,
    message: `出动命令已受理（接令时间 ${stamp}），队伍转为「已出动」，火情报告待出警清单已新增一份`,
  }
}

// 火情报告页的待出警清单：已确认、等待队伍出警的报告（含队伍出动时联动新增的那一份）。
export function listPendingDispatchReports(): EntryRow[] {
  return listRows(FIREREPORT_KEY).filter((row) => String(row.status) === '已确认')
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
