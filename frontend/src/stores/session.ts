import { defineStore } from 'pinia'

import { DEFAULT_FARM, FARMS, isFarm } from '@/data/forest-farm'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    // 当前值班台所属林场：扑火队伍按它建立权限边界，只有本林场值班台能改动队伍资料
    farm: DEFAULT_FARM as string,
    farms: FARMS as readonly string[],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    // 切换值班林场，用于模拟同一终端以不同林场身份操作（跨林场越权会被数据层拦截）
    setFarm(farm: string) {
      this.farm = isFarm(farm) ? farm : DEFAULT_FARM
    },
  },
})
