// 林场边界：扑火队伍按所属林场隔离写权限，切换值班身份用于演示跨林场越权拦截。
export const FARMS = ['青松岭林场', '白桦林林场', '红松岗林场'] as const

export type FarmName = (typeof FARMS)[number]

export const DEFAULT_FARM: FarmName = FARMS[0]

export function isFarm(value: string): value is FarmName {
  return (FARMS as readonly string[]).includes(value)
}
