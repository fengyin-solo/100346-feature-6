// 逻辑验证脚本（不进产物）：模拟两个林场值班台 + 两台终端共用一份 localStorage。
import { createPinia, setActivePinia } from 'pinia'

import { runTeamAction, updateTeamProfile, transferTeam, listEntries } from './src/api/local-service'
import { useSessionStore } from './src/stores/session'
import { allRows } from './src/data/local-store'

setActivePinia(createPinia())

const mem: Record<string, string> = {}
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = v
    },
    removeItem: (k: string) => delete mem[k],
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const qsl = { operator: '青松岭值班员', farm: '青松岭林场' }
const bhl = { operator: '白桦林值班员', farm: '白桦林林场' }

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${detail}`)
  }
}

// 1. 越权拦截：白桦林值班台改青松岭队伍的受保护字段与动作
console.log('① 林场权限边界')
const deniedEdit = updateTeamProfile(1, { 队伍编号: 'X', 队长姓名: 'X', 集结半径: '1公里' }, bhl)
check('外林场改队伍编号/队长/集结半径被拦截', !deniedEdit.ok && deniedEdit.message.includes('越权拦截'), deniedEdit.message)
const deniedDispatch = runTeamAction(1, '下达出动', bhl)
check('外林场下达出动被拦截', !deniedDispatch.ok && deniedDispatch.message.includes('越权拦截'), deniedDispatch.message)
const deniedTransfer = transferTeam(1, '白桦林林场', bhl)
check('外林场调岗被拦截', !deniedTransfer.ok, deniedTransfer.message)
const canView = listEntries('fireteam', { 所属林场: '青松岭林场' }).items.length
check('外林场仍可查看（筛选不受限）', canView >= 1, `命中 ${canView}`)

// 2. 本林场正常改动
console.log('② 本林场值班台改动受保护字段')
const okEdit = updateTeamProfile(1, { 队伍编号: 'TEAM-QSL-01', 队长姓名: '赵建国', 集结半径: '18公里' }, qsl)
check('本林场改集结半径成功', okEdit.ok, okEdit.message)
const team1 = allRows().fireteam.find((r) => r.id === 1)!
check('新集结半径已落库', team1['集结半径'] === '18公里')

// 3. 两台终端同时下达出动：只落库一次，火情报告也只新增一份
console.log('③ 两台终端同时提交出动确认（幂等）')
const reportsBefore = allRows().firereport.length
const t1 = runTeamAction(2, '下达出动', bhl) // 终端A
const t2 = runTeamAction(2, '下达出动', bhl) // 终端B（同一秒模拟并发）
check('终端A受理成功', t1.ok && !t1.duplicated, t1.message)
check('终端B被判重复提交、未二次落库', t2.ok && t2.duplicated === true, t2.message)
const team2 = allRows().fireteam.find((r) => r.id === 2)!
check('队伍只出动一次（状态=已出动，接令时间唯一）', team2.status === '已出动' && Boolean(team2['接令时间']))
const reportsAfter = allRows().firereport
check('待出警清单只新增一份', reportsAfter.length === reportsBefore + 1, `before=${reportsBefore} after=${reportsAfter.length}`)
const linked = reportsAfter.filter((r) => r['关联队伍编号'] === 'TEAM-BHL-02')
check('联动报告带关联队伍编号且为待出警', linked.some((r) => r.status === '待出警'))

// 4. 冲突出动命令按接令时间：首条已受理后，晚到的另一条命令（不同值班员、30s窗口内）驳回
console.log('④ 冲突出动命令按接令时间处理')
const realNow = Date.now
Date.now = () => realNow() + 3000 // 模拟第二条命令晚 3 秒到达
const again = runTeamAction(2, '下达出动', { operator: '白桦林值班员B', farm: '白桦林林场' })
Date.now = realNow
check('后到出动命令被驳回并提示首条接令时间', !again.ok && again.message.includes('接令时间'), again.message)

// 5. 调岗：当前归属变化、历史归属不变、留痕
console.log('⑤ 跨林场调岗与历史归属')
const before = allRows().fireteam.find((r) => r.id === 4)!
check('调岗前归属青松岭、历史归属白桦林', before['所属林场'] === '青松岭林场' && before['历史归属林场'] === '白桦林林场')
const tr = transferTeam(4, '红松岗林场', qsl)
check('原林场发起调岗成功', tr.ok, tr.message)
const after = allRows().fireteam.find((r) => r.id === 4)!
check('当前归属变为红松岗', after['所属林场'] === '红松岗林场')
check('历史归属仍为白桦林林场（原林场）', after['历史归属林场'] === '白桦林林场')
check('变更记录追加且保留原调岗痕迹', String(after['归属变更记录']).includes('白桦林林场 → 青松岭林场') && String(after['归属变更记录']).includes('青松岭林场 → 红松岗林场'))
// 调岗后原林场失去写权限、新林场获得权限
const oldOwnerEdit = updateTeamProfile(4, { 队伍编号: 'TEAM-QSL-04', 队长姓名: '周海峰', 集结半径: '25公里' }, qsl)
check('调岗后原林场再改被拦截', !oldOwnerEdit.ok, oldOwnerEdit.message)
const newOwnerAction = runTeamAction(4, '转入休整', { operator: '红松岗值班员', farm: '红松岗林场' })
check('调岗后新林场可操作', newOwnerAction.ok, newOwnerAction.message)

// 6. store 林场切换
console.log('⑥ 会话林场切换')
const store = useSessionStore()
store.setFarm('红松岗林场')
check('切换值班林场生效', store.farm === '红松岗林场')
store.setFarm('不存在的林场')
check('非法林场回退默认', store.farm === '青松岭林场')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
