import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    // 当前值班人所属林场：扑火队伍的改动权限按它与队伍「所属林场」比对，其他林场只能查看。
    station: '青松林场',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setStation(station: string) {
      this.station = station
    },
  },
})
