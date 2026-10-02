<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">按所属林场建立权限边界：仅本林场值班台可改动队伍编号、队长姓名、集结半径并下达出动，其它林场只读；跨林场调岗只改当前归属，历史归属仍归原林场。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
      </div>
    </header>

    <p class="scope-banner" :class="{ readonly: !hasAnyOwnedRow }">
      当前值班林场：<strong>{{ store.farm }}</strong>
      <template v-if="hasAnyOwnedRow">
        · 本林场 {{ ownedCount }} 支队伍可操作；其余林场队伍仅可查看，越权提交会被数据层拦截
      </template>
      <template v-else>
        · 本林场当前没有归属队伍，列表全部为只读
      </template>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>接令时间</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'readonly-row': !isOwned(row) }">
          <td v-for="column in columns" :key="column" :title="column === '归属变更记录' ? String(row[column]) : undefined">
            <template v-if="column === '所属林场'">
              {{ row[column] }}
              <span v-if="String(row['历史归属林场']) !== String(row[column])" class="tag tag-warn" title="历史归属">
                原属{{ row['历史归属林场'] }}
              </span>
            </template>
            <template v-else-if="column === '归属变更记录'">
              <span v-if="row[column]">已调岗</span>
              <span v-else class="muted">—</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row['接令时间'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!isOwned(row)"
              :title="isOwned(row) ? action : `仅${row['所属林场']}值班台可操作`"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <!-- 编辑受保护字段：本林场值班台才能打开并提交，提交时数据层再做一次边界校验 -->
    <div v-if="editTarget" class="modal-mask" @click.self="closeEdit">
      <div class="modal">
        <h3>编辑队伍资料 · {{ editTarget['队伍名称'] }}</h3>
        <p class="modal-tip">归属林场：{{ editTarget['所属林场'] }}（历史归属：{{ editTarget['历史归属林场'] }}）。队伍编号、队长姓名、集结半径仅本林场值班台可改。</p>
        <label class="modal-field">
          <span>队伍编号</span>
          <input v-model="editForm['队伍编号']" />
        </label>
        <label class="modal-field">
          <span>队长姓名</span>
          <input v-model="editForm['队长姓名']" />
        </label>
        <label class="modal-field">
          <span>集结半径</span>
          <input v-model="editForm['集结半径']" placeholder="如 15公里" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeEdit">取消</button>
          <button class="btn primary" type="button" @click="submitEdit">提交修改</button>
        </div>
      </div>
    </div>

    <!-- 跨林场调岗：只更新当前归属并追加留痕，历史归属林场不动 -->
    <div v-if="transferTarget" class="modal-mask" @click.self="closeTransfer">
      <div class="modal">
        <h3>跨林场调岗 · {{ transferTarget['队伍名称'] }}</h3>
        <p class="modal-tip">当前归属：{{ transferTarget['所属林场'] }}；调岗后历史归属仍记「{{ transferTarget['历史归属林场'] }}」。</p>
        <label class="modal-field">
          <span>调往林场</span>
          <select v-model="transferFarm">
            <option v-for="farm in otherFarms(transferTarget)" :key="farm" :value="farm">{{ farm }}</option>
          </select>
        </label>
        <p v-if="transferHistory" class="history-box">{{ transferHistory }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeTransfer">取消</button>
          <button class="btn primary" type="button" @click="submitTransfer">确认调岗</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="feedback" :class="feedbackClass">{{ feedback }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runTeamAction,
  transferTeam,
  updateTeamProfile,
} from '@/api/local-service'
import { FARMS } from '@/data/forest-farm'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('fireteam')
// 归属变更记录不占表格列，用「已调岗」标记 + 调岗弹窗展示完整留痕
const columns = ["队伍编号", "队伍名称", "所属林场", "历史归属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态", "归属变更记录"]
const actions = ["下达出动", "编辑资料", "跨林场调岗", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const feedback = ref('')
const feedbackKind = ref<'error' | 'success'>('error')
const filters = ref<Record<string, string>>({})
const filterFields = ["队伍编号", "队伍名称", "所属林场"]

const editTarget = ref<EntryRow | null>(null)
const editForm = reactive({ 队伍编号: '', 队长姓名: '', 集结半径: '' })
const transferTarget = ref<EntryRow | null>(null)
const transferFarm = ref('')

const feedbackClass = computed(() => (feedbackKind.value === 'error' ? 'error-text' : 'success-text'))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '队伍总数', value: rows.value.length },
  { label: '本林场可操作', value: ownedCount.value },
  { label: '出动/扑救中', value: rows.value.filter((row) => ['已出动', '扑救中'].includes(String(row.status))).length },
])
const ownedCount = computed(() => rows.value.filter((row) => isOwned(row)).length)
const hasAnyOwnedRow = computed(() => ownedCount.value > 0)
const transferHistory = computed(() =>
  transferTarget.value ? String(transferTarget.value['归属变更记录'] ?? '') : '',
)

function isOwned(row: EntryRow): boolean {
  return String(row['所属林场'] ?? '') === store.farm
}

function otherFarms(row: EntryRow): string[] {
  return FARMS.filter((farm) => farm !== String(row['所属林场'] ?? ''))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  feedbackKind.value = 'error'
  feedback.value = '扑火队伍登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  feedback.value = ''
  if (action === '编辑资料') {
    openEdit(row)
    return
  }
  if (action === '跨林场调岗') {
    openTransfer(row)
    return
  }
  const result = runTeamAction(Number(row.id), action, { operator: store.operator, farm: store.farm })
  feedbackKind.value = result.ok ? 'success' : 'error'
  feedback.value = result.message
  reload()
}

function openEdit(row: EntryRow) {
  editTarget.value = row
  editForm.队伍编号 = String(row['队伍编号'] ?? '')
  editForm.队长姓名 = String(row['队长姓名'] ?? '')
  editForm.集结半径 = String(row['集结半径'] ?? '')
}

function closeEdit() {
  editTarget.value = null
}

function submitEdit() {
  if (!editTarget.value) {
    return
  }
  const result = updateTeamProfile(
    Number(editTarget.value.id),
    { ...editForm },
    { operator: store.operator, farm: store.farm },
  )
  feedbackKind.value = result.ok ? 'success' : 'error'
  feedback.value = result.message
  if (result.ok) {
    closeEdit()
  }
  reload()
}

function openTransfer(row: EntryRow) {
  transferTarget.value = row
  transferFarm.value = otherFarms(row)[0] ?? ''
}

function closeTransfer() {
  transferTarget.value = null
}

function submitTransfer() {
  if (!transferTarget.value) {
    return
  }
  const result = transferTeam(
    Number(transferTarget.value.id),
    transferFarm.value,
    { operator: store.operator, farm: store.farm },
  )
  feedbackKind.value = result.ok ? 'success' : 'error'
  feedback.value = result.message
  if (result.ok) {
    closeTransfer()
  }
  reload()
}

function reload() {
  feedback.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    feedbackKind.value = 'error'
    feedback.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>
