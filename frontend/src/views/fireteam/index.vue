<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">维护扑火队伍，围绕队伍编号、队伍名称、所属林场、队长姓名做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <label class="station-switch">
          <span>当前值班林场</span>
          <select v-model="session.station">
            <option v-for="station in stations" :key="station" :value="station">{{ station }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
      </div>
    </header>

    <p class="scope-note">
      权限边界：仅本林场值班人员可改动队伍编号、队长姓名、集结半径（含调岗）；其他林场只能查看，越权提交由服务层拦截。
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
          <th>接令林场</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column" :title="historyTitle(row, column)">
            {{ row[column] ?? '—' }}
            <small v-if="column === '所属林场' && historyOf(row).length" class="history-mark">
              （含调岗履历 {{ historyOf(row).length }} 段）
            </small>
          </td>
          <td>{{ row['接令时间'] || '—' }}</td>
          <td>{{ row['接令林场'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              class="link"
              type="button"
              :title="canEdit(row) ? '调整队伍信息' : '其他林场的队伍只能查看'"
              @click="openEdit(row)"
            >
              调整队伍
            </button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <div v-if="editing" class="modal-mask" @click.self="closeEdit">
      <form class="modal-card" @submit.prevent="submitEdit">
        <h3>调整队伍信息 · {{ String(editing['队伍名称']) }}</h3>
        <p class="modal-scope">
          队伍归属「{{ String(editing['所属林场']) }}」｜当前值班身份「{{ session.station }}」
          <span v-if="!editable" class="error-text">— 非本林场，只能查看，无法提交</span>
        </p>
        <label class="form-item">
          <span>所属林场（调岗后历史归属仍归原林场）</span>
          <input v-model="form.所属林场" list="station-options" :disabled="!editable" />
          <datalist id="station-options">
            <option v-for="station in stations" :key="station" :value="station" />
          </datalist>
        </label>
        <label class="form-item">
          <span>队伍编号</span>
          <input v-model="form.队伍编号" :disabled="!editable" />
        </label>
        <label class="form-item">
          <span>队长姓名</span>
          <input v-model="form.队长姓名" :disabled="!editable" />
        </label>
        <label class="form-item">
          <span>集结半径（公里）</span>
          <input v-model="form.集结半径" :disabled="!editable" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeEdit">取消</button>
          <button class="btn primary" type="submit" :disabled="!editable">提交调整</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="errorMessage" :class="['error-text', { 'warn-text': lastDuplicated }]">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listStations,
  moduleMeta,
  runFireteamAction,
  updateFireteam,
  type TeamPatch,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fireteam')
const columns = ["队伍编号", "队伍名称", "所属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态"]
const actions = ["下达出动", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const lastDuplicated = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stations = ref<string[]>([])

const editing = ref<EntryRow | null>(null)
const formError = ref('')
const form = reactive<TeamPatch>({ 所属林场: '', 队伍编号: '', 队长姓名: '', 集结半径: '' })

const stats = computed(() => [
  { label: '队伍总数', value: rows.value.length },
  {
    label: '待命队伍',
    value: rows.value.filter((row) => String(row.status) === '在营待命').length,
  },
  {
    label: '出动队伍',
    value: rows.value.filter((row) => ['已出动', '扑救中'].includes(String(row.status))).length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const editable = computed(() =>
  editing.value !== null && String(editing.value['所属林场']) === session.station,
)

function canEdit(row: EntryRow): boolean {
  return String(row['所属林场']) === session.station
}

function historyOf(row: EntryRow): { 林场: string; 生效时间: string; 原因: string }[] {
  const raw = row['归属历史']
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as { 林场: string; 生效时间: string; 原因: string }[]) : []
  } catch {
    return []
  }
}

function historyTitle(row: EntryRow, column: string): string {
  if (column !== '所属林场') {
    return ''
  }
  const history = historyOf(row)
  if (!history.length) {
    return ''
  }
  return history.map((item) => `${item.林场} 至 ${item.生效时间}（${item.原因}）`).join('\n')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
}

function openEdit(row: EntryRow) {
  editing.value = row
  formError.value = ''
  form.所属林场 = String(row['所属林场'] ?? '')
  form.队伍编号 = String(row['队伍编号'] ?? '')
  form.队长姓名 = String(row['队长姓名'] ?? '')
  form.集结半径 = String(row['集结半径'] ?? '')
}

function closeEdit() {
  editing.value = null
  formError.value = ''
}

function submitEdit() {
  if (!editing.value) {
    return
  }
  formError.value = ''
  const result = updateFireteam(Number(editing.value.id), { ...form }, session.station)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeEdit()
  reload()
  errorMessage.value = result.message
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  lastDuplicated.value = false
  const result = runFireteamAction(Number(row.id), action, session.station)
  lastDuplicated.value = Boolean(result.duplicated)
  errorMessage.value = result.message
  reload()
}

function reload() {
  try {
    stations.value = listStations()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>
