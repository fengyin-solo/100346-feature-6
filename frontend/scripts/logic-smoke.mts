// 业务逻辑冒烟测试：用假 localStorage 在 Node 里直跑数据层与服务层，
// 覆盖权限边界、接令冲突、调岗历史归属、跨模块新增、双终端去重。
import { loadModule } from 'vm'

const stores = new Map()
function makeLocalStorage(prefix) {
  return {
    getItem: (k) => (stores.has(prefix + k) ? stores.get(prefix + k) : null),
    setItem: (k, v) => stores.set(prefix + k, String(v)),
    removeItem: (k) => stores.delete(prefix + k),
  }
}
// 两个终端（标签页）共享同一个 storage（模拟同浏览器 BroadcastChannel 之外的 localStorage 共享）。
const shared = makeLocalStorage('')
globalThis.window = { localStorage: shared }

await import('./src/data/local-store.ts')
