import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 跨终端共享的辅助台账（出动命令去重等）：每次都直读 localStorage，不走内存缓存，
// 这样同一浏览器下两台终端（标签页）几乎同时提交时能互相看见对方先落下的受理记录。
const META_STORAGE_KEY = 'forest-fire-patrol:meta'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 辅助台账始终直读 localStorage（带内存缓存会看不到另一台终端刚写入的受理记录）。
export function readMeta<T>(segment: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(META_STORAGE_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return (segment in parsed ? parsed[segment] : fallback) as T
  } catch {
    return fallback
  }
}

export function writeMeta(segment: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const raw = window.localStorage.getItem(META_STORAGE_KEY)
  let parsed: Record<string, unknown> = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  }
  parsed[segment] = value
  window.localStorage.setItem(META_STORAGE_KEY, JSON.stringify(parsed))
}
