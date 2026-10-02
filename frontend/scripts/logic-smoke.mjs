// 业务逻辑冒烟测试：用共享的假 localStorage 模拟同浏览器两台终端（标签页），
// 覆盖权限边界、接令冲突、调岗历史归属、跨模块新增、双终端去重。
// 运行：node scripts/logic-smoke.mjs （经 vite SSR 加载 TS 源码）
import { createServer as createViteServer } from 'vite'

const stores = new Map()
const sharedLocalStorage = {
  getItem: (k) => (stores.has(k) ? stores.get(k) : null),
  setItem: (k, v) => stores.set(k, String(v)),
  removeItem: (k) => stores.delete(k),
  clear: () => stores.clear(),
}
globalThis.window = { localStorage: sharedLocalStorage }

const vite = await createViteServer({
  server: { middlewareMode: true },
  logLevel: 'error',
  appType: 'custom',
})

const service = await vite.ssrLoadModule('/src/api/local-service.ts')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name} ${detail}`)
  }
}

// 终端 A：青松林场；终端 B：翠柏林场。两边每次调用都重新从 localStorage 读。
const stationA = '青松林场'
const stationB = '翠柏林场'

// 1) 越权改队伍编号被拦截（翠柏想改青松的队伍 1）
let r = service.updateFireteam(1, {
  所属林场: '青松林场',
  队伍编号: 'HACK-0001',
  队长姓名: '周国栋',
  集结半径: '15',
}, stationB)
check('其他林场改动队伍编号被拦截', r.ok === false && r.message.includes('越权拦截'), JSON.stringify(r))

// 本林场修改成功
r = service.updateFireteam(1, {
  所属林场: '青松林场',
  队伍编号: 'FIRE-0001',
  队长姓名: '周正',
  集结半径: '18',
}, stationA)
check('本林场修改队长/集结半径成功', r.ok, JSON.stringify(r))

// 集结半径非法值
r = service.updateFireteam(1, {
  所属林场: '青松林场', 队伍编号: 'FIRE-0001', 队长姓名: '周正', 集结半径: 'abc',
}, stationA)
check('集结半径非数字被拦截', r.ok === false)

// 2) 调岗：青松 -> 红枫林场；历史归属保留在原林场
r = service.updateFireteam(1, {
  所属林场: '红枫林场', 队伍编号: 'FIRE-0001', 队长姓名: '周正', 集结半径: '18',
}, stationA)
check('本林场发起调岗成功', r.ok && r.message.includes('历史归属保留'), JSON.stringify(r))

const teamsAfterMove = service.listEntries('fireteam').items
const team1 = teamsAfterMove.find((t) => t.id === 1)
const history = JSON.parse(team1['归属历史'])
check('调岗后归属变更为新林场', team1['所属林场'] === '红枫林场', team1['所属林场'])
check('历史归属仍记原林场', history.length === 1 && history[0].林场 === '青松林场', JSON.stringify(history))

// 调岗后原林场不能再改，新林场可以改
r = service.updateFireteam(1, {
  所属林场: '红枫林场', 队伍编号: 'FIRE-0001', 队长姓名: '周正', 集结半径: '18',
}, stationA)
check('调岗后原林场再改被拦截', r.ok === false && r.message.includes('越权拦截'))

// listStations 同时包含新林场与历史林场
const stations = service.listStations()
check('林场清单含当前与历史归属', stations.includes('红枫林场') && stations.includes('青松林场'), JSON.stringify(stations))

// 3) 冲突命令按接令时间处理：队伍 2 已出动，重复出动被拦截
r = service.runFireteamAction(2, '下达出动', stationB)
check('已出动队伍的第二张命令被拦截（按接令时间）', r.ok === false && r.message.includes('出动冲突'), JSON.stringify(r))
check('冲突拦截不落任何新报告', service.listEntries('firereport').items.length === 3)

// 4) 正常出动（队伍 1 此刻在红枫林场，在营待命）
const before = service.listEntries('firereport').items.length
r = service.runFireteamAction(1, '下达出动', '红枫林场')
check('出动确认成功', r.ok && !r.duplicated, JSON.stringify(r))
const team1b = service.listEntries('fireteam').items.find((t) => t.id === 1)
check('队伍状态转已出动并快照接令林场', team1b.status === '已出动' && team1b['接令林场'] === '红枫林场' && Boolean(team1b['接令时间']))
const after = service.listEntries('firereport').items
check('火情报告待出警清单新增一份', after.length === before + 1)
const added = after[after.length - 1]
check('新增报告为已确认/待出警且带跨入口来源', added.status === '已确认' && added['来源入口'] === '扑火队伍-下达出动' && added['接令林场'] === '红枫林场', JSON.stringify(added))
check('待出警清单包含新增报告', service.listPendingDispatchReports().some((x) => x.id === added.id))

// 5) 两台终端几乎同时提交同一队伍的出动：第二台只识别不重落库
// 队伍 1 刚出动，先撤回再模拟双终端同时点出动。
service.runFireteamAction(1, '撤回队伍', '红枫林场')
const reportBeforeDup = service.listEntries('firereport').items.length
const rA = service.runFireteamAction(1, '下达出动', '红枫林场')
const rB = service.runFireteamAction(1, '下达出动', '红枫林场')
check('终端A首次出动落库', rA.ok && !rA.duplicated, JSON.stringify(rA))
check('终端B并发提交识别为重复', rB.ok && rB.duplicated === true, JSON.stringify(rB))
check('双终端提交火情报告只新增一次', service.listEntries('firereport').items.length === reportBeforeDup + 1)
const team1c = service.listEntries('fireteam').items.find((t) => t.id === 1)
check('队伍只保留一条接令记录', Boolean(team1c['接令时间']))

// 6) 撤回后接令快照清空，但调岗历史仍在
service.runFireteamAction(1, '撤回队伍', '红枫林场')
const team1d = service.listEntries('fireteam').items.find((t) => t.id === 1)
check('撤回清空接令时间/林场', team1d['接令时间'] === '' && team1d['接令林场'] === '')
check('撤回不影响历史归属', JSON.parse(team1d['归属历史']).length === 1)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
